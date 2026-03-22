/**
 * Firebase configuration — Auth, Firestore, and Analytics.
 * Works in both dev and production via VITE_FIREBASE_* env vars.
 * If vars are missing, Firebase is disabled gracefully (local dev without auth).
 */
import { initializeApp, type FirebaseApp } from 'firebase/app'
import {
    getAuth,
    GoogleAuthProvider,
    signInWithRedirect,
    signOut,
    onAuthStateChanged,
    type Auth,
    type User
} from 'firebase/auth'
import {
    getFirestore,
    collection,
    addDoc,
    getDocs,
    getDoc,
    deleteDoc,
    updateDoc,
    doc,
    query,
    orderBy,
    serverTimestamp,
    type Firestore,
    type Timestamp
} from 'firebase/firestore'
import { getAnalytics } from 'firebase/analytics'

const firebaseConfig = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
    measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
}

let app: FirebaseApp | null = null
let auth: Auth | null = null
let db: Firestore | null = null

export const isFirebaseConfigured = !!firebaseConfig.apiKey

if (isFirebaseConfigured) {
    app = initializeApp(firebaseConfig)
    auth = getAuth(app)
    db = getFirestore(app)
    // Analytics only works in browser (not SSR)
    if (typeof window !== 'undefined' && firebaseConfig.measurementId) {
        try { getAnalytics(app) } catch { /* ignore in non-browser envs */ }
    }
}

// ─── Auth ───────────────────────────────────────────────────────────────────

const googleProvider = new GoogleAuthProvider()

export async function signInWithGoogle(): Promise<void> {
    if (!auth) return
    await signInWithRedirect(auth, googleProvider)
}

export async function firebaseSignOut(): Promise<void> {
    if (!auth) return
    await signOut(auth)
}

export async function getIdToken(): Promise<string | null> {
    if (!auth?.currentUser) return null
    try { return await auth.currentUser.getIdToken() } catch { return null }
}

export function onAuthChange(callback: (user: User | null) => void): () => void {
    if (!auth) { callback(null); return () => { } }
    return onAuthStateChanged(auth, callback)
}

export type { User }

// ─── Firestore: Saved Graphics ───────────────────────────────────────────────

export interface SavedGraphic {
    id: string
    title: string
    subtitle: string
    svg_html: string
    controls_html: string
    narration_context: string
    source_labels: string[]
    created_at: Timestamp | null
}

function graphicsCollection(uid: string) {
    if (!db) throw new Error('Firestore not initialized')
    return collection(db, 'users', uid, 'graphics')
}

/** Save a newly generated graphic to Firestore. */
export async function saveGraphic(
    uid: string,
    data: Omit<SavedGraphic, 'id' | 'created_at'>
): Promise<string> {
    const col = graphicsCollection(uid)
    const docRef = await addDoc(col, {
        ...data,
        created_at: serverTimestamp(),
    })
    return docRef.id
}

/** List all saved graphics for a user (newest first). */
export async function listGraphics(uid: string): Promise<SavedGraphic[]> {
    const col = graphicsCollection(uid)
    const q = query(col, orderBy('created_at', 'desc'))
    const snap = await getDocs(q)
    return snap.docs.map(d => ({ id: d.id, ...d.data() } as SavedGraphic))
}

/** Load a single saved graphic by ID. */
export async function getGraphic(uid: string, graphicId: string): Promise<SavedGraphic | null> {
    if (!db) return null
    const ref = doc(db, 'users', uid, 'graphics', graphicId)
    const snap = await getDoc(ref)
    if (!snap.exists()) return null
    return { id: snap.id, ...snap.data() } as SavedGraphic
}

/** Delete a saved graphic. */
export async function deleteGraphic(uid: string, graphicId: string): Promise<void> {
    if (!db) return
    await deleteDoc(doc(db, 'users', uid, 'graphics', graphicId))
}

/** Update a field on a saved graphic (e.g. svg_html). */
export async function updateGraphicField(uid: string, graphicId: string, field: string, value: string): Promise<void> {
    if (!db) return
    await updateDoc(doc(db, 'users', uid, 'graphics', graphicId), { [field]: value })
}

/**
 * Patch all saved graphics matching a title: find/replace in svg_html.
 * Call from browser console: window._patchGraphics('Macroscopic Quantum Tunnelling', 'font-size="11"', 'font-size="9"')
 */
export async function patchGraphicsSvg(uid: string, title: string, find: string, replace: string): Promise<number> {
    const graphics = await listGraphics(uid)
    let count = 0
    for (const g of graphics) {
        if (g.title.includes(title) && g.svg_html.includes(find)) {
            const newSvg = g.svg_html.replaceAll(find, replace)
            await updateGraphicField(uid, g.id, 'svg_html', newSvg)
            count++
            console.log(`[Patch] Updated graphic ${g.id} "${g.title}"`)
        }
    }
    console.log(`[Patch] Done — updated ${count} graphic(s)`)
    return count
}

// ─── Firestore: Public Curated Examples ──────────────────────────────────────

/** List public curated examples (no auth required). */
export async function listPublicExamples(): Promise<SavedGraphic[]> {
    if (!db) return []
    const col = collection(db, 'public_examples')
    const q = query(col, orderBy('order', 'asc'))
    const snap = await getDocs(q)
    return snap.docs.map(d => ({ id: d.id, ...d.data() } as SavedGraphic))
}

/** Copy a user's graphic into the public_examples collection. */
export async function publishToExamples(uid: string, graphicId: string, order: number): Promise<string> {
    if (!db) throw new Error('Firestore not initialized')
    const graphic = await getGraphic(uid, graphicId)
    if (!graphic) throw new Error(`Graphic ${graphicId} not found`)
    const docRef = await addDoc(collection(db, 'public_examples'), {
        title: graphic.title,
        subtitle: graphic.subtitle,
        svg_html: graphic.svg_html,
        controls_html: graphic.controls_html,
        narration_context: graphic.narration_context,
        source_labels: graphic.source_labels,
        order,
        created_at: serverTimestamp(),
    })
    console.log(`[Publish] Published "${graphic.title}" as example #${order} (${docRef.id})`)
    return docRef.id
}

/** Patch public examples: find/replace in svg_html by title. */
export async function patchPublicExamplesSvg(title: string, find: string, replace: string): Promise<number> {
    if (!db) return 0
    const col = collection(db, 'public_examples')
    const snap = await getDocs(col)
    let count = 0
    for (const d of snap.docs) {
        const data = d.data() as SavedGraphic
        if (data.title?.includes(title) && data.svg_html?.includes(find)) {
            const newSvg = data.svg_html.replaceAll(find, replace)
            await updateDoc(doc(db, 'public_examples', d.id), { svg_html: newSvg })
            count++
            console.log(`[Patch] Updated public example ${d.id} "${data.title}"`)
        }
    }
    console.log(`[Patch] Done — updated ${count} public example(s)`)
    return count
}

/** Inspect svg_html snippet around a keyword for all public examples matching a title. */
export async function inspectPublicExampleSvg(title: string, keyword: string): Promise<void> {
    if (!db) return
    const col = collection(db, 'public_examples')
    const snap = await getDocs(col)
    for (const d of snap.docs) {
        const data = d.data() as SavedGraphic
        if (data.title?.includes(title)) {
            const idx = data.svg_html?.indexOf(keyword) ?? -1
            if (idx >= 0) {
                console.log(`[${d.id}] "${data.title}" — snippet:`)
                console.log(data.svg_html.slice(Math.max(0, idx - 80), idx + 80))
            } else {
                console.log(`[${d.id}] "${data.title}" — keyword NOT FOUND`)
            }
        }
    }
}

/** Remove all public examples (for re-curating). */
export async function clearPublicExamples(): Promise<number> {
    if (!db) return 0
    const col = collection(db, 'public_examples')
    const snap = await getDocs(col)
    let count = 0
    for (const d of snap.docs) {
        await deleteDoc(doc(db, 'public_examples', d.id))
        count++
    }
    console.log(`[Publish] Cleared ${count} public example(s)`)
    return count
}
