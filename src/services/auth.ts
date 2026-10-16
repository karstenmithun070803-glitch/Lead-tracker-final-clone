/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getAuth,
  signInWithPopup,
  GoogleAuthProvider,
  onAuthStateChanged,
  User,
  signOut,
} from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';

// Initialize or reuse Firebase App instance
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
export const auth = getAuth(app);

export const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file',
];

const provider = new GoogleAuthProvider();
SCOPES.forEach((scope) => provider.addScope(scope));

// Google access tokens live ~1 hour and cannot be refreshed client-side. Keep one in memory and
// mirror it to sessionStorage (this tab only, never localStorage) so a page reload or dev
// hot-reload does not force a new Google sign-in. It is dropped once it is about to expire.
const TOKEN_KEY = 'lt_google_access_token';
const TOKEN_TTL_MS = 55 * 60 * 1000;

const saveToken = (token: string | null) => {
  try {
    if (token) {
      sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ token, exp: Date.now() + TOKEN_TTL_MS }));
    } else {
      sessionStorage.removeItem(TOKEN_KEY);
    }
  } catch {
    /* storage unavailable: in-memory only */
  }
};

const loadToken = (): string | null => {
  try {
    const raw = sessionStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const { token, exp } = JSON.parse(raw);
    if (token && typeof exp === 'number' && exp > Date.now()) return token;
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
  return null;
};

let isSigningIn = false;
let cachedAccessToken: string | null = loadToken();

export const initAuth = (
  onAuthSuccess?: (user: User, token: string) => void,
  onAuthFailure?: () => void
) => {
  return onAuthStateChanged(auth, async (user: User | null) => {
    if (user) {
      if (cachedAccessToken) {
        if (onAuthSuccess) onAuthSuccess(user, cachedAccessToken);
      } else if (!isSigningIn) {
        // If user is logged in to Firebase but token is not in memory, user can re-trigger sign-in popup
        if (onAuthFailure) onAuthFailure();
      }
    } else {
      cachedAccessToken = null;
      saveToken(null);
      if (onAuthFailure) onAuthFailure();
    }
  });
};

export const googleSignIn = async (): Promise<{ user: User; accessToken: string } | null> => {
  try {
    isSigningIn = true;
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('Failed to get access token from Google Auth');
    }

    cachedAccessToken = credential.accessToken;
    saveToken(cachedAccessToken);
    return { user: result.user, accessToken: cachedAccessToken };
  } catch (error: any) {
    console.error('Sign in error:', error);
    throw error;
  } finally {
    isSigningIn = false;
  }
};

export const getAccessToken = async (): Promise<string | null> => {
  return cachedAccessToken;
};

export const setCachedAccessToken = (token: string | null) => {
  cachedAccessToken = token;
  saveToken(token);
};

export const logout = async () => {
  await signOut(auth);
  cachedAccessToken = null;
  saveToken(null);
};
