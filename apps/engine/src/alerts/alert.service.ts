import { Inject, Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import { AppConfigService } from "../config/config.service";
import { createLogger } from "../logger";
import { SignalBus } from "../signals/signal-bus";
import { momentumEventSummary } from "./templates";

/**
 * Alert fan-out (SPEC §1, §7): dashboard delivery is the WS gateway; this
 * service adds the optional Telegram webhook, gated by TELEGRAM_BOT_TOKEN /
 * TELEGRAM_CHAT_ID. Copy comes ONLY from templates.ts (audited surface).
 */
@Injectable()
export class AlertService implements OnApplicationBootstrap {
  private readonly log = createLogger("alerts");
  private readonly token: string;
  private readonly chatId: string;
  sent = 0;
  failed = 0;

  constructor(
    @Inject(AppConfigService) config: AppConfigService,
    @Inject(SignalBus) private readonly bus: SignalBus,
  ) {
    this.token = process.env.TELEGRAM_BOT_TOKEN ?? "";
    this.chatId = process.env.TELEGRAM_CHAT_ID ?? "";
  }

  get telegramEnabled(): boolean {
    return this.token !== "" && this.chatId !== "";
  }

  onApplicationBootstrap(): void {
    if (!this.telegramEnabled) {
      this.log.info("telegram alerts disabled (no token/chat configured)");
      return;
    }
    this.bus.onEvent((e) =>
      void this.send(`${e.instrumentKey}\n${momentumEventSummary(e)}`),
    );
    this.bus.onLifecycle((t) =>
      void this.send(`${t.episode.instrumentKey}\n${t.summary}`),
    );
  }

  private async send(text: string): Promise<void> {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${this.token}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: this.chatId, text }),
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.sent += 1;
    } catch (err) {
      this.failed += 1;
      if (this.failed === 1) {
        this.log.warn({ err: (err as Error).message }, "telegram send failed");
      }
    }
  }
}
