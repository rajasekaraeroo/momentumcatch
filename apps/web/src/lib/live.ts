"use client";
import { useEffect, useRef, useState } from "react";
import type {
  Episode,
  LifecycleTransition,
  MomentumEvent,
  MomentumSnapshot,
} from "@momentum-scan/shared";

export const ENGINE_URL =
  process.env.NEXT_PUBLIC_ENGINE_URL ?? "http://localhost:3001";
export const ENGINE_WS =
  ENGINE_URL.replace(/^http/, "ws") + "/live";

export interface LiveSnapshot extends MomentumSnapshot {
  premium?: number;
}

export interface TapeItem {
  kind: "event" | "lifecycle";
  ts: number;
  event?: MomentumEvent;
  lifecycle?: LifecycleTransition;
}

export interface FeedStatus {
  state: string;
  subscriptionCount: number;
  protoAvailable: boolean;
  metrics: Record<string, number | null>;
  connections?: Record<string, string>;
}

export interface FocusPool {
  slots: string[];
  capacity: number;
  connectionState: string;
}

export interface UniverseInstrument {
  instrumentKey: string;
  kind: "option" | "index";
  side?: 1 | -1;
  underlying: string;
  underlyingKey?: string;
  strike?: number;
  expiry?: string;
}

export interface LiveState {
  connected: boolean;
  snapshots: Map<string, LiveSnapshot>;
  scoreHistory: Map<string, { ts: number; score: number }[]>;
  tape: TapeItem[];
  episodes: Map<string, Episode>;
  feed: FeedStatus | null;
  focusPool: FocusPool | null;
  instruments: UniverseInstrument[];
  selections: { underlying: string; expiry: string; atm: number }[];
}

const MAX_TAPE = 150;
const MAX_SCORE_HISTORY = 600;

/** WS /live + REST /universe client (SPEC §7). Reconnects with backoff. */
export function useLive(): LiveState {
  const [, force] = useState(0);
  const state = useRef<LiveState>({
    connected: false,
    snapshots: new Map(),
    scoreHistory: new Map(),
    tape: [],
    episodes: new Map(),
    feed: null,
    focusPool: null,
    instruments: [],
    selections: [],
  });

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 1000;
    let renderTimer: ReturnType<typeof setInterval> | null = null;

    const connect = (): void => {
      if (closed) return;
      ws = new WebSocket(ENGINE_WS);
      ws.onopen = () => {
        state.current.connected = true;
        retry = 1000;
      };
      ws.onclose = () => {
        state.current.connected = false;
        if (!closed) setTimeout(connect, (retry = Math.min(retry * 2, 15000)));
      };
      ws.onmessage = (m) => {
        const { type, data } = JSON.parse(m.data as string);
        const s = state.current;
        if (type === "snapshot") {
          const snap = data as LiveSnapshot;
          s.snapshots.set(snap.instrumentKey, snap);
          const hist = s.scoreHistory.get(snap.instrumentKey) ?? [];
          hist.push({ ts: snap.ts, score: snap.score });
          if (hist.length > MAX_SCORE_HISTORY) hist.splice(0, hist.length - MAX_SCORE_HISTORY);
          s.scoreHistory.set(snap.instrumentKey, hist);
        } else if (type === "event") {
          s.tape.unshift({ kind: "event", ts: data.ts, event: data });
          s.tape.splice(MAX_TAPE);
        } else if (type === "lifecycle") {
          const t = data as LifecycleTransition;
          s.tape.unshift({ kind: "lifecycle", ts: t.ts, lifecycle: t });
          s.tape.splice(MAX_TAPE);
          if (t.episode.state === "DEAD") s.episodes.delete(t.episode.instrumentKey);
          else s.episodes.set(t.episode.instrumentKey, t.episode);
        } else if (type === "health") {
          s.feed = data.feed;
          s.focusPool = data.focusPool ?? null;
          s.episodes = new Map(
            (data.episodes as Episode[]).map((e) => [e.instrumentKey, e]),
          );
        } else if (type === "feedState" && s.feed) {
          s.feed = { ...s.feed, state: data.state };
        }
      };
    };
    connect();

    const loadUniverse = async (): Promise<void> => {
      try {
        const res = await fetch(`${ENGINE_URL}/universe`);
        const body = await res.json();
        state.current.instruments = body.instruments ?? [];
        state.current.selections = body.selections ?? [];
        state.current.feed = body.feed ?? state.current.feed;
      } catch {
        /* engine not up yet — banner shows via feed=null */
      }
    };
    void loadUniverse();
    const universeTimer = setInterval(() => void loadUniverse(), 60_000);

    // batch re-renders to 2/s instead of per-message
    renderTimer = setInterval(() => force((n) => n + 1), 500);

    return () => {
      closed = true;
      ws?.close();
      clearInterval(universeTimer);
      if (renderTimer) clearInterval(renderTimer);
    };
  }, []);

  return state.current;
}
