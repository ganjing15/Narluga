import { useState, useRef, useEffect } from 'react'
import { XIcon, SparklesIcon, DisplayIcon, NarlugaLogo, RefreshIcon } from './Icons'
import { deleteGraphic, type User, type SavedGraphic } from './firebase'

interface GraphicsPageProps {
    savedGraphics: SavedGraphic[]
    galleryLoading: boolean
    user: User
    onOpenGraphic: (g: SavedGraphic) => void
    onDeleteGraphic: (id: string) => void
    onBack: () => void
}



// Renders a live scaled-down preview of the SVG
export const SvgThumbnail = ({ svgHtml }: { svgHtml: string }) => {
    const wrapperRef = useRef<HTMLDivElement>(null)
    const [transform, setTransform] = useState('scale(0.35)')

    // Extract only the <svg ...>...</svg> content, strip scripts for safety
    const svgMatch = svgHtml.match(/<svg[\s\S]*<\/svg>/i)

    // Parse viewBox to get natural SVG dimensions (avoids DOM measurement issues)
    const vbMatch = svgMatch?.[0].match(/viewBox=["']([^"']+)["']/i)
    const vbParts = vbMatch?.[1].split(/[\s,]+/).map(Number)
    const svgW = (vbParts && vbParts.length >= 4 && vbParts[2] > 0) ? vbParts[2] : 800
    const svgH = (vbParts && vbParts.length >= 4 && vbParts[3] > 0) ? vbParts[3] : 500

    useEffect(() => {
        const wrapper = wrapperRef.current
        if (!wrapper) return
        const ro = new ResizeObserver(() => {
            const wW = wrapper.clientWidth
            const wH = wrapper.clientHeight
            if (wW <= 0 || wH <= 0) return
            // Scale to cover (fill) the thumbnail area like object-fit: cover
            const s = Math.max(wW / svgW, wH / svgH)
            // Center the scaled content
            const offsetX = (wW - svgW * s) / 2
            const offsetY = (wH - svgH * s) / 2
            setTransform(`translate(${offsetX}px, ${offsetY}px) scale(${s})`)
        })
        ro.observe(wrapper)
        return () => ro.disconnect()
    }, [svgW, svgH])

    if (!svgMatch) return <SparklesIcon className="w-8 h-8 text-[var(--accent-primary)] opacity-30" />

    const safe = svgMatch[0]
        .replace(/<script[\s\S]*?<\/script>/gi, '')   // strip scripts
        .replace(/\son\w+="[^"]*"/gi, '')              // strip inline handlers
        .replace(/\son\w+='[^']*'/gi, '')

    return (
        <div ref={wrapperRef} style={{ width: '100%', height: '100%', overflow: 'hidden', position: 'relative' }}>
            <div
                className="svg-thumbnail-inner"
                style={{
                    pointerEvents: 'none',
                    width: `${svgW}px`,
                    height: `${svgH}px`,
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    transformOrigin: 'top left',
                    transform,
                }}
                dangerouslySetInnerHTML={{ __html: safe }}
            />
        </div>
    )
}


export function GraphicsPage({ savedGraphics, galleryLoading, user, onOpenGraphic, onDeleteGraphic, onBack }: GraphicsPageProps) {
    const [deletingId, setDeletingId] = useState<string | null>(null)
    const [graphicToDelete, setGraphicToDelete] = useState<SavedGraphic | null>(null)

    const handleDeleteClick = (e: React.MouseEvent, g: SavedGraphic) => {
        e.stopPropagation()
        setGraphicToDelete(g)
    }

    const confirmDelete = async () => {
        if (!graphicToDelete) return
        setDeletingId(graphicToDelete.id)

        try {
            await deleteGraphic(user.uid, graphicToDelete.id)
            onDeleteGraphic(graphicToDelete.id)
        } catch (err) {
            console.error('Failed to delete graphic:', err)
        } finally {
            setDeletingId(null)
            setGraphicToDelete(null)
        }
    }

    const cancelDelete = () => {
        setGraphicToDelete(null)
    }

    return (
        <div className="graphics-page">
            {/* Page header */}
            <div className="graphics-page-header">
                <div className="app-logo flex items-center gap-3">
                    <button onClick={onBack} className="cursor-pointer hover:opacity-80 transition-opacity">
                        <NarlugaLogo className="w-11 h-11 drop-shadow-sm" />
                    </button>
                    <span className="text-2xl font-extrabold tracking-tighter text-slate-800">
                        My Graphics
                    </span>
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






                                        <div className="flex items-center justify-between mt-3">
                                            {g.created_at && (
                                                <span className="text-[11px] text-slate-400">
                                                    {new Date((g.created_at as any).seconds * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                                                </span>
                                            )}
                                            <div className="flex items-center gap-2 ml-auto">
                                                <button
                                                    className="graphic-card-action delete"
                                                    onClick={(e) => handleDeleteClick(e, g)}
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

            {/* Delete Confirmation Modal */}
            {graphicToDelete && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-in fade-in duration-200">
                    <div className="bg-white rounded-2xl shadow-xl w-[90%] max-w-md overflow-hidden animate-in zoom-in-95 duration-200">
                        <div className="p-6">
                            <h3 className="text-lg font-semibold text-slate-800 mb-2">Delete Graphic</h3>
                            <p className="text-sm text-slate-500 mb-6">
                                Are you sure you want to delete <span className="font-semibold text-slate-700">"{graphicToDelete.title}"</span>? This action cannot be undone.
                            </p>

                            <div className="flex items-center justify-end gap-3">
                                <button
                                    onClick={cancelDelete}
                                    disabled={deletingId !== null}
                                    className="px-4 py-2 text-sm font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors disabled:opacity-50"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={confirmDelete}
                                    disabled={deletingId !== null}
                                    className="flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-red-500 hover:bg-red-600 rounded-lg transition-colors shadow-sm disabled:opacity-50"
                                >
                                    {deletingId ? (
                                        <>
                                            <RefreshIcon className="w-4 h-4 animate-spin" />
                                            Deleting...
                                        </>
                                    ) : (
                                        'Delete'
                                    )}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}
