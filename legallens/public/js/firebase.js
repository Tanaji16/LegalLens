import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAnalytics, isSupported } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-analytics.js";
import {
  getAuth, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signInWithPopup, GoogleAuthProvider, sendPasswordResetEmail, updateProfile, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

// Dynamically load Firebase config from server environment (no hardcoded keys in repository)
let firebaseConfig = window.__FIREBASE_CONFIG__;
if (!firebaseConfig || !firebaseConfig.apiKey) {
  try {
    const res = await fetch('/api/firebase-config');
    if (res.ok) {
      firebaseConfig = await res.json();
    }
  } catch (err) {
    console.warn('[Firebase] Could not fetch configuration:', err);
  }
}

export const app = initializeApp(firebaseConfig || {});
isSupported().then(ok => ok && getAnalytics(app)).catch(() => {});
export const auth = getAuth(app);
const google = new GoogleAuthProvider();

export const watchAuth = cb => onAuthStateChanged(auth, cb);
export const loginEmail = (email, pw) => signInWithEmailAndPassword(auth, email, pw);
export const loginGoogle = () => signInWithPopup(auth, google);
export const resetPassword = email => sendPasswordResetEmail(auth, email);
export const logout = () => signOut(auth);
export async function signUpEmail({ name, email, password }) {
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  await updateProfile(cred.user, { displayName: name });
  return cred;
}

export function friendlyError(e) {
  const m = {
    'auth/invalid-credential': 'Incorrect email or password.',
    'auth/user-not-found': 'No account found with this email.',
    'auth/wrong-password': 'Incorrect email or password.',
    'auth/email-already-in-use': 'An account with this email already exists.',
    'auth/weak-password': 'Password should be at least 6 characters.',
    'auth/invalid-email': 'Please enter a valid email address.',
    'auth/popup-closed-by-user': 'Google sign-in was cancelled.',
    'auth/too-many-requests': 'Too many attempts. Please try again later.',
    'auth/network-request-failed': 'Network error. Check your connection.',
    'auth/unauthorized-domain': 'This domain is not authorized in Firebase Console > Authentication > Settings.',
  };
  return m[e.code] || e.message || 'Something went wrong.';
}
