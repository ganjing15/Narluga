/**
 * Firebase configuration — Auth, Firestore, and Analytics.
 * Works in both dev and production via VITE_FIREBASE_* env vars.
 * If vars are missing, Firebase is disabled gracefully (local dev without auth).
 */
import { initializeApp, type FirebaseApp } from 'firebase/app'
import {
    getAuth,
    GoogleAuthProvider,
    signInWithPopup,
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

export async function signInWithGoogle(): Promise<User | null> {
    if (!auth) return null
    const result = await signInWithPopup(auth, googleProvider)
    return result.user
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
