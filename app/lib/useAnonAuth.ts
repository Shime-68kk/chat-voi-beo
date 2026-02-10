"use client";

import { useEffect, useState } from "react";
import { auth } from "./firebase";
import { onAuthStateChanged, signInAnonymously, User } from "firebase/auth";

export function useAnonAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (!u) {
        await signInAnonymously(auth);
        return;
      }
      setUser(u);
      setReady(true);
    });
    return () => unsub();
  }, []);

  return { user, ready };
}
