"use client";

import { useState } from "react";
import { useAnonAuth } from "../lib/useAnonAuth";
import { db } from "../lib/firebase";
import { doc, serverTimestamp, setDoc } from "firebase/firestore";
import { nanoid } from "nanoid";

export default function CreateInvitePage() {
  const { user, ready } = useAnonAuth();
  const [link, setLink] = useState("");

  async function createInvite() {
    if (!user) return;

    const inviteCode = nanoid(10);
    const roomId = nanoid(16);

   await setDoc(doc(db, "rooms", roomId), {
  members: [user.uid],
  createdAt: serverTimestamp(),
  lastMessageAt: serverTimestamp(),
  seenAt: {},         
  typing: {},         
});

    const expiresAt = Date.now() + 1000 * 60 * 60 * 24; // 24h

    await setDoc(doc(db, "invites", inviteCode), {
  roomId,
  hostUid: user.uid,
  guestUid: null,
  status: "open",
  createdAt: serverTimestamp(),
  expiresAt,
});

    setLink(`${window.location.origin}/chat/${inviteCode}`);
  }
  async function copyToClipboard(text: string) {
  try {
    if (navigator?.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {}

  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  ta.style.top = "-9999px";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  document.execCommand("copy");
  document.body.removeChild(ta);
}

  if (!ready) return <div className="p-6">Loading…</div>;

  return (
    <div className="p-6 max-w-xl">
      <h1 className="text-2xl font-semibold">Tạo link chat 1–1</h1>

      <button
        onClick={createInvite}
        className="mt-4 px-4 py-2 rounded bg-black text-white"
      >
        Tạo link
      </button>

      {link && (
        <div className="mt-4">
          <div className="font-medium">Link của bạn:</div>
          <input
            className="w-full border p-2 rounded mt-2"
            value={link}
            readOnly
          />
         <button
  className="mt-2 px-3 py-2 rounded border"
  onClick={() => copyToClipboard(link)}
>
  Copy
</button>

        </div>
      )}
    </div>
  );
}
