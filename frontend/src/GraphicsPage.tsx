import { useState, useRef, useEffect } from 'react'
import { XIcon, SparklesIcon, DisplayIcon, NarlugaLogo, RefreshIcon, YoutubeIcon, LinkIcon, FileUploadIcon, TextIcon } from './Icons'
import { deleteGraphic, type User, type SavedGraphic } from './firebase'

interface GraphicsPageProps {
    savedGraphics: SavedGraphic[]
    galleryLoading: boolean
    user: User
    onOpenGraphic: (g: SavedGraphic) => void
    onDeleteGraphic: (id: string) => void
    onBack: () => void
}

const SourceTypeIcon = ({ label }: { label: string }) => {
    const l = label.toLowerCase()
    if (l.startsWith('youtube:')) return <YoutubeIcon className="w-3.5 h-3.5" />
    if (l.startsWith('http')) return <LinkIcon className="w-3.5 h-3.5" />
    if (l.startsWith('file:') || l.endsWith('.pdf') || l.endsWith('.txt')) return <FileUploadIcon className="w-3.5 h-3.5" />
    return <TextIcon className="w-3.5 h-3.5" />
}

// Renders a live scaled-down preview of the SVG
const SvgThumbnail = ({ svgHtml }: { svgHtml: string }) => {
    const wrapperRef = useRef<HTMLDivElement>(null)
    const [scale, setScale] = useState(0.467)

    useEffect(() => {
        const el = wrapperRef.current
        if (!el) return
        const ro = new ResizeObserver(entries => {
            for (const entry of entries) {
                const w = entry.contentRect.width
                if (w > 0) setScale(w / 600)
            }
        })
        ro.observe(el)
        return () => ro.disconnect()
    }, [])

    // Extract only the <svg ...>...</svg> content, strip scripts for safety
    const svgMatch = svgHtml.match(/<svg[\s\S]*<\/svg>/i)
    if (!svgMatch) return <SparklesIcon className="w-8 h-8 text-[var(--accent-primary)] opacity-30" />

    const safe = svgMatch[0]
        .replace(/<script[\s\S]*?<\/script>/gi, '')   // strip scripts
        .replace(/\son\w+="[^"]*"/gi, '')              // strip inline handlers
        .replace(/\son\w+='[^']*'/gi, '')

    return (
        <div ref={wrapperRef} style={{ width: '100%', height: '100%', overflow: 'hidden', position: 'relative' }}>
            <div
                style={{
                    pointerEvents: 'none',
                    width: '600px',
                    height: '400px',
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    transformOrigin: 'top left',
                    transform: `scale(${scale})`,
                }}
                dangerouslySetInnerHTML={{ __html: safe }}
            />
        </div>
    )
}


export function GraphicsPage({ savedGraphics, galleryLoading, user, onOpenGraphic, onDeleteGraphic, onBack }: GraphicsPageProps) {
    const [deletingId, setDeletingId] = useState<string | null>(null)

    const handleDelete = async (e: React.MouseEvent, id: string) => {
        e.stopPropagation()
        setDeletingId(id)
        await deleteGraphic(user.uid, id)
        onDeleteGraphic(id)
        setDeletingId(null)
    }

    return (
        <div className="graphics-page">
            {/* Page header */}
            <div className="graphics-page-header">
                <div className="flex items-center gap-3">
                    <NarlugaLogo className="w-8 h-8" />
                    <button
                        onClick={onBack}
                        className="text-sm text-slate-400 hover:text-[var(--accent-primary)] transition-colors font-medium"
                    >
                        Narluga
                    </button>
                    <span className="text-slate-300">/</span>
                    <span className="text-sm font-semibold text-slate-700">My Graphics</span>
                </div>
                <button
                    onClick={onBack}
                    className="flex items-center gap-2 px-4 py-2 rounded-full bg-[var(--accent-primary)] text-white text-sm font-semibold hover:bg-[#0a48ad] transition-all shadow-sm hover:shadow-md"
                >
                    <SparklesIcon className="w-4 h-4" />
                    Create New
                </button>
            </div>

            {/* Page body */}
            <div className="graphics-page-body">
                {galleryLoading ? (
                    <div className="flex flex-col items-center justify-center h-64 gap-4">
                        <div className="w-8 h-8 border-2 border-slate-200 border-t-[var(--accent-primary)] rounded-full animate-spin" />
                        <p className="text-sm text-slate-400">Loading your graphics...</p>
                    </div>
                ) : savedGraphics.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-64 gap-4 text-center">
                        <DisplayIcon className="w-14 h-14 text-slate-200" />
                        <div>
                            <p className="text-base font-semibold text-slate-600">No graphics yet</p>
                            <p className="text-sm text-slate-400 mt-1">Generate your first interactive graphic to see it here.</p>
                        </div>
                        <button
                            onClick={onBack}
                            className="mt-2 flex items-center gap-2 px-5 py-2.5 rounded-full bg-[var(--accent-primary)] text-white text-sm font-semibold hover:bg-[#0a48ad] transition-all shadow-sm"
                        >
                            <SparklesIcon className="w-4 h-4" />
                            Get started
                        </button>
                    </div>
                ) : (
                    <>
                        <div className="graphics-page-count">
                            {savedGraphics.length} graphic{savedGraphics.length !== 1 ? 's' : ''}
                        </div>
                        <div className="graphics-grid">
                            {savedGraphics.map(g => (
                                <div
                                    key={g.id}
                                    className="graphic-card"
                                    onClick={() => onOpenGraphic(g)}
                                >
                                    {/* Card preview — live SVG thumbnail */}
                                    <div className="graphic-card-preview">
                                        {g.svg_html ? (
                                            <SvgThumbnail svgHtml={g.svg_html} />
                                        ) : (
                                            <SparklesIcon className="w-8 h-8 text-[var(--accent-primary)] opacity-30" />
                                        )}
                                    </div>

                                    {/* Card info */}
                                    <div className="graphic-card-info">
                                        <h3 className="graphic-card-title">{g.title}</h3>


                                        {g.source_labels?.length > 0 && (() => {
                                            // Group labels by source type
                                            const groups: Record<string, string[]> = {}
                                            for (const label of g.source_labels) {
                                                const l = label.toLowerCase()
                                                const type = l.startsWith('youtube:') ? 'youtube'
                                                    : l.startsWith('http') ? 'url'
                                                        : (l.startsWith('file:') || l.endsWith('.pdf') || l.endsWith('.txt')) ? 'file'
                                                            : 'text'
                                                    ; (groups[type] ??= []).push(label)
                                            }
                                            return (
                                                <div className="graphic-card-sources">
                                                    {Object.entries(groups).map(([type, labels]) => {
                                                        const first = labels[0]
                                                        const count = labels.length
                                                        const isYt = type === 'youtube'
                                                        const singleHref = isYt && count === 1
                                                            ? `https://youtube.com/watch?v=${first.replace(/^youtube:\s*/i, '')}`
                                                            : undefined
                                                        const tooltip = count === 1 ? first : `${count} ${type} sources`
                                                        const Chip = singleHref ? 'a' : 'span'
                                                        return (
                                                            <Chip
                                                                key={type}
                                                                className="graphic-card-source-icon"
                                                                title={tooltip}
                                                                {...(singleHref ? { href: singleHref, target: '_blank', rel: 'noopener noreferrer', onClick: (e: React.MouseEvent) => e.stopPropagation() } : {})}
                                                            >
                                                                <SourceTypeIcon label={first} />
                                                                {count > 1 && <span className="source-icon-count">{count}</span>}
                                                            </Chip>
                                                        )
                                                    })}
                                                </div>
                                            )
                                        })()}



                                        <div className="flex items-center justify-between mt-3">
                                            {g.created_at && (
                                                <span className="text-[11px] text-slate-400">
                                                    {new Date((g.created_at as any).seconds * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                                                </span>
                                            )}
                                            <div className="flex items-center gap-2 ml-auto">
                                                <button
                                                    className="graphic-card-action delete"
                                                    onClick={(e) => handleDelete(e, g.id)}
                                                    title="Delete"
                                                    disabled={deletingId === g.id}
                                                >
                                                    {deletingId === g.id ? (
                                                        <RefreshIcon className="w-3.5 h-3.5 animate-spin" />
                                                    ) : (
                                                        <XIcon className="w-3.5 h-3.5" />
                                                    )}
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </>
                )}
            </div>
        </div>
    )
}
