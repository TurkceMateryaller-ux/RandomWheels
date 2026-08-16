import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js';
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut
} from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js';
import {
  getFirestore,
  collection,
  collectionGroup,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  query,
  where
} from 'https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js';

const firebaseConfig = {
  apiKey: "AIzaSyBqHeI7pOQanYJKine8u8tJ_orS5Q0IpRs",
  authDomain: "randomwheels.firebaseapp.com",
  projectId: "randomwheels",
  storageBucket: "randomwheels.firebasestorage.app",
  messagingSenderId: "952320694255",
  appId: "1:952320694255:web:bc5def3fdd21aa6708481a"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

export {
  app,
  auth,
  db,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  collection,
  collectionGroup,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  query,
  where
};
