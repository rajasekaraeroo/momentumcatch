import { EventEmitter } from "node:events";
import { Injectable } from "@nestjs/common";
import type {
  LifecycleTransition,
  MomentumEvent,
  MomentumSnapshot,
} from "@momentum-scan/shared";

/**
 * In-process pub/sub between momentum → lifecycle → alerts → WS gateway.
 * Typed wrapper over EventEmitter; consumers never see the raw emitter.
 */
@Injectable()
export class SignalBus {
  private readonly emitter = new EventEmitter().setMaxListeners(50);

  emitSnapshot(s: MomentumSnapshot): void {
    this.emitter.emit("snapshot", s);
  }
  onSnapshot(cb: (s: MomentumSnapshot) => void): void {
    this.emitter.on("snapshot", cb);
  }

  emitEvent(e: MomentumEvent): void {
    this.emitter.emit("event", e);
  }
  onEvent(cb: (e: MomentumEvent) => void): void {
    this.emitter.on("event", cb);
  }

  emitLifecycle(t: LifecycleTransition): void {
    this.emitter.emit("lifecycle", t);
  }
  onLifecycle(cb: (t: LifecycleTransition) => void): void {
    this.emitter.on("lifecycle", cb);
  }
}
