"use client";

import { useEffect, useMemo, useRef, useState, use } from "react";
import { useAnonAuth } from "@/app/lib/useAnonAuth";
import { db } from "@/app/lib/firebase";
import {
  addDoc,
  arrayRemove,
  arrayUnion,
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  updateDoc,
} from "firebase/firestore";

type Msg = any;
const REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "😡"] as const;

const STICKERS = [{ id: "1", url: "/stickers/1.png" }];

function formatTime(ts: any) {
  const d = ts?.toDate?.() ?? (typeof ts === "number" ? new Date(ts) : null);
  if (!d) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function TypingDots() {
  return (
    <div className="inline-flex items-center gap-2 px-3 py-2 rounded-2xl bg-neutral-200">
      <span className="dot" />
      <span className="dot delay1" />
      <span className="dot delay2" />
      <style jsx>{`
        .dot {
          width: 10px;
          height: 10px;
          border-radius: 9999px;
          background: #555;
          display: inline-block;
          animation: bounce 1.1s infinite ease-in-out;
        }
        .delay1 {
          animation-delay: 0.15s;
        }
        .delay2 {
          animation-delay: 0.3s;
        }
        @keyframes bounce {
          0%,
          80%,
          100% {
            transform: translateY(0);
            opacity: 0.5;
          }
          40% {
            transform: translateY(-6px);
            opacity: 1;
          }
        }
      `}</style>
    </div>
  );
}

export default function ChatPage({
  params,
}: {
  params: Promise<{ inviteCode: string }>;
}) {
  const { inviteCode } = use(params);
  const { user, ready } = useAnonAuth();

  const [roomId, setRoomId] = useState<string | null>(null);
  const [status, setStatus] = useState<
    "loading" | "ok" | "full" | "expired" | "invalid"
  >("loading");

  const [messages, setMessages] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  const [showStickers, setShowStickers] = useState(false);
  const [unread, setUnread] = useState(0);

  const [otherSeenAt, setOtherSeenAt] = useState<any>(null);
  const [otherTyping, setOtherTyping] = useState(false);

  const [atBottom, setAtBottom] = useState(false);

  const lastSeenRef = useRef<number>(Date.now());
  const typingTimerRef = useRef<any>(null);

  const msgsRef = useMemo(() => {
    if (!roomId) return null;
    return collection(db, "rooms", roomId, "messages");
  }, [roomId]);

  // --- Claim invite + join room ---
  useEffect(() => {
    if (!ready || !user) return;

    (async () => {
      try {
        const inviteRef = doc(db, "invites", inviteCode);

        const res = await runTransaction(db, async (tx) => {
          const inviteSnap = await tx.get(inviteRef);
          if (!inviteSnap.exists()) return { kind: "invalid" as const };

          const inv = inviteSnap.data() as any;

          if (typeof inv.expiresAt === "number" && Date.now() > inv.expiresAt) {
            return { kind: "expired" as const };
          }

          const roomRef = doc(db, "rooms", inv.roomId);
          const roomSnap = await tx.get(roomRef);
          if (!roomSnap.exists()) return { kind: "invalid" as const };

          const room = roomSnap.data() as any;
          const members: string[] = room.members || [];

          if (members.includes(user.uid)) {
            return { kind: "ok" as const, roomId: inv.roomId };
          }

          if (inv.guestUid && inv.guestUid !== user.uid) {
            return { kind: "full" as const };
          }

          if (members.length >= 2) {
            return { kind: "full" as const };
          }

          tx.update(inviteRef, { guestUid: user.uid, status: "claimed" });
          tx.update(roomRef, { members: [...members, user.uid] });

          return { kind: "ok" as const, roomId: inv.roomId };
        });

        if (res.kind === "ok") {
          setRoomId(res.roomId);
          setStatus("ok");
        } else if (res.kind === "full") setStatus("full");
        else if (res.kind === "expired") setStatus("expired");
        else setStatus("invalid");
      } catch {
        setStatus("invalid");
      }
    })();
  }, [ready, user, inviteCode]);

  // --- Cleanup typing on unmount ---
  useEffect(() => {
    return () => {
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);

      if (roomId && user) {
        const rid = roomId;
        const uid = user.uid;
        updateDoc(doc(db, "rooms", rid), {
          [`typing.${uid}`]: false,
        }).catch(() => {});
      }
    };
  }, [roomId, user]);

  // --- Listen messages ---
  useEffect(() => {
    if (!msgsRef) return;

    const qy = query(msgsRef, orderBy("createdAt", "asc"), limit(50));
    const unsub = onSnapshot(qy, (snap) => {
      const arr: Msg[] = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
      setMessages(arr);

      // track newest time when tab visible (for unread)
      if (!document.hidden) {
        const newest = arr[arr.length - 1];
        const newestTime =
          newest?.createdAt?.toDate?.()?.getTime?.() ??
          (typeof newest?.createdAt === "number" ? newest.createdAt : 0);
        if (newestTime) lastSeenRef.current = newestTime;
      }

      // unread counter when hidden and message from other
      const newest = arr[arr.length - 1];
      const newestTime =
        newest?.createdAt?.toDate?.()?.getTime?.() ??
        (typeof newest?.createdAt === "number" ? newest.createdAt : 0);

      const isFromOther = newest?.senderId && newest.senderId !== user?.uid;
      if (document.hidden && isFromOther && newestTime > lastSeenRef.current) {
        setUnread((u) => u + 1);
      }

      // autoscroll only if atBottom
      if (atBottom) {
        setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
      }
    });

    return () => unsub();
  }, [msgsRef, user, atBottom]);

  // --- Listen room (seenAt + typing) ---
  useEffect(() => {
    if (!roomId || !user) return;

    const rid = roomId;
    const roomRef = doc(db, "rooms", rid);

    const unsub = onSnapshot(roomRef, (snap) => {
      const room = snap.data() as any;
      if (!room) return;

      const members: string[] = room.members || [];
      const otherUid = members.find((uid) => uid !== user.uid);
      if (!otherUid) return;

      const seen = room.seenAt || {};
      setOtherSeenAt(seen[otherUid] || null);

      const typing = room.typing || {};
      setOtherTyping(Boolean(typing[otherUid]));
    });

    return () => unsub();
  }, [roomId, user]);

  // --- Mark seen ONLY when: visible + atBottom ---
  useEffect(() => {
    if (!roomId || !user) return;

    const rid = roomId;
    const uid = user.uid;

    async function markSeen() {
      if (document.hidden) return;
      if (!atBottom) return;

      await updateDoc(doc(db, "rooms", rid), {
        [`seenAt.${uid}`]: serverTimestamp(),
      });
    }

    // when reaching bottom OR messages change while at bottom
    markSeen();

    const onVis = () => {
      if (!document.hidden) markSeen();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [roomId, user, atBottom, messages.length]);

  // --- Title + reset unread when visible ---
  useEffect(() => {
    const base = "Chat 1–1";
    document.title = unread > 0 ? `🔴 ${unread} tin nhắn mới` : base;
  }, [unread]);

  useEffect(() => {
    function onVis() {
      if (!document.hidden) {
        setUnread(0);
        document.title = "Chat 1–1";
      }
    }
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  async function setTyping(isTyping: boolean) {
    if (!roomId || !user) return;

    const rid = roomId;
    const uid = user.uid;
    await updateDoc(doc(db, "rooms", rid), {
      [`typing.${uid}`]: isTyping,
    });
  }

  async function send() {
    if (!user || !roomId) return;
    const t = text.trim();
    if (!t) return;

    setText("");
    await setTyping(false);

    await addDoc(collection(db, "rooms", roomId, "messages"), {
      type: "text",
      text: t,
      senderId: user.uid,
      createdAt: serverTimestamp(),
      reactions: {},
    });

    await updateDoc(doc(db, "rooms", roomId), { lastMessageAt: serverTimestamp() });
  }

  async function sendSticker(s: { id: string; url: string }) {
    if (!user || !roomId) return;

    await addDoc(collection(db, "rooms", roomId, "messages"), {
      type: "sticker",
      stickerId: s.id,
      stickerUrl: s.url,
      senderId: user.uid,
      createdAt: serverTimestamp(),
      reactions: {},
    });

    await updateDoc(doc(db, "rooms", roomId), { lastMessageAt: serverTimestamp() });
    setShowStickers(false);
  }

  async function toggleReaction(messageId: string, emoji: string) {
    if (!user || !roomId) return;

    const msgRef = doc(db, "rooms", roomId, "messages", messageId);
    const field = `reactions.${emoji}`;

    const m: any = (messages as any).find((x: any) => x.id === messageId);
    const arr: string[] = m?.reactions?.[emoji] ?? [];
    const has = arr.includes(user.uid);

    await updateDoc(msgRef, {
      [field]: has ? arrayRemove(user.uid) : arrayUnion(user.uid),
    });
  }

  // --- Messenger-like "Đã xem": show under LAST message of mine, if otherSeenAt >= that msg time ---
  const lastMine = [...messages].reverse().find((m) => m.senderId === user?.uid);
  const lastMineTime =
    lastMine?.createdAt?.toDate?.()?.getTime?.() ??
    (typeof lastMine?.createdAt === "number" ? lastMine.createdAt : 0);

  const otherSeenTime =
    otherSeenAt?.toDate?.()?.getTime?.() ??
    (typeof otherSeenAt === "number" ? otherSeenAt : 0);

  const showSeen = Boolean(lastMine && otherSeenTime && otherSeenTime >= lastMineTime);

  if (!ready) return <div className="p-6">Loading…</div>;
  if (status === "loading") return <div className="p-6">Đang vào phòng…</div>;
  if (status === "full") return <div className="p-6">Phòng này đã đủ 2 người.</div>;
  if (status === "expired") return <div className="p-6">Link đã hết hạn.</div>;
  if (status === "invalid") return <div className="p-6">Link không hợp lệ.</div>;

  return (
    <div className="h-[100dvh] flex flex-col">
      <div className="p-4 border-b font-semibold flex items-center justify-between">
        <span>Chat 1–1</span>
        {unread > 0 && (
          <span className="text-xs px-2 py-1 rounded-full bg-red-600 text-white">
            {unread}
          </span>
        )}
      </div>

      <div
        className="flex-1 overflow-auto p-4 space-y-3 bg-neutral-50"
        onScroll={(e) => {
          const el = e.currentTarget;
          const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
          setAtBottom(nearBottom);
        }}
      >
        {(messages as any).map((m: any) => {
          const mine = m.senderId === user?.uid;
          const rx = m.reactions || {};
          const rxList = Object.entries(rx)
            .map(([emoji, uids]: any) => ({ emoji, count: (uids || []).length }))
            .filter((x) => x.count > 0);

          const isLastMine = mine && lastMine?.id === m.id;

          return (
            <div
              key={m.id}
              className={"flex " + (mine ? "justify-end" : "justify-start")}
            >
              <div className="max-w-[78%]">
                <div
                  className={
                    "rounded-2xl px-3 py-2 shadow-sm border " +
                    (mine ? "bg-black text-white border-black" : "bg-white text-black")
                  }
                >
                  {m.type === "sticker" ? (
                    <img src={m.stickerUrl} alt="sticker" className="w-28 h-28 object-contain" />
                  ) : (
                    <span className="whitespace-pre-wrap break-words">{m.text}</span>
                  )}

                  {rxList.length > 0 && (
                    <div className="mt-2 flex gap-1 flex-wrap">
                      {rxList.map((r) => (
                        <button
                          key={r.emoji}
                          className="text-xs px-2 py-1 rounded-full border bg-white text-black"
                          onClick={() => toggleReaction(m.id, r.emoji)}
                        >
                          {r.emoji} {r.count}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className={"mt-1 text-xs text-neutral-500 " + (mine ? "text-right" : "text-left")}>
                  {formatTime(m.createdAt)}
                </div>

                <div className={"mt-1 flex gap-1 " + (mine ? "justify-end" : "justify-start")}>
                  {REACTIONS.map((emoji) => (
                    <button
                      key={emoji}
                      className="text-sm px-2 py-1 rounded-full border bg-white hover:bg-neutral-100"
                      onClick={() => toggleReaction(m.id, emoji)}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>

                {isLastMine && showSeen && (
                  <div className="mt-1 text-xs text-neutral-500 text-right">
                    Đã xem {formatTime(otherSeenAt)}
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {/* Typing bubble like Messenger */}
        {otherTyping && (
          <div className="flex justify-start">
            <TypingDots />
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      <div className="p-3 border-t bg-white">
        <div className="flex gap-2 items-center">
          <button
            className="px-3 py-2 rounded-xl border hover:bg-neutral-50"
            onClick={() => setShowStickers((v) => !v)}
            title="Sticker"
          >
            😀
          </button>

          <input
            className="flex-1 border rounded-2xl px-4 py-2 outline-none"
            value={text}
            onChange={(e) => {
              setText(e.target.value);

              setTyping(true);

              if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
              typingTimerRef.current = setTimeout(() => setTyping(false), 1200);
            }}
            placeholder="Nhập tin nhắn…"
            onKeyDown={(e) => e.key === "Enter" && send()}
          />

          <button className="px-4 py-2 rounded-2xl bg-black text-white" onClick={send}>
            Gửi
          </button>
        </div>

        {showStickers && (
          <div className="mt-3 border rounded-2xl p-2 bg-white">
            <div className="text-sm font-medium mb-2">Sticker</div>
            <div className="flex gap-2 flex-wrap">
              {STICKERS.map((s) => (
                <button
                  key={s.id}
                  className="p-2 rounded-xl border hover:bg-neutral-50"
                  onClick={() => sendSticker(s)}
                >
                  <img src={s.url} alt={s.id} className="w-16 h-16 object-contain" />
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
