import { Inject, Injectable } from "@nestjs/common";
import type Redis from "ioredis";
import { AppConfigService } from "../config/config.service";
import { createLogger } from "../logger";
import { REDIS } from "../redis/redis.module";
import { secondsUntilTokenExpiry } from "./token-ttl";

const TOKEN_KEY = "upstox:token";

export interface AuthStatus {
  authenticated: boolean;
  expiresAt: string | null;
}

/**
 * Daily OAuth token lifecycle (SPEC §12.2). The token lives ONLY in Redis —
 * it is never logged and never written to disk (CLAUDE.md hard rule 4).
 */
@Injectable()
export class AuthService {
  private readonly log = createLogger("auth");

  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  loginUrl(): string {
    const { UPSTOX_API_KEY, UPSTOX_REDIRECT_URI } = this.config.env;
    const params = new URLSearchParams({
      client_id: UPSTOX_API_KEY,
      redirect_uri: UPSTOX_REDIRECT_URI,
      response_type: "code",
    });
    return `https://api.upstox.com/v2/login/authorization/dialog?${params}`;
  }

  async exchangeCode(code: string): Promise<void> {
    const { UPSTOX_API_KEY, UPSTOX_API_SECRET, UPSTOX_REDIRECT_URI } =
      this.config.env;
    const res = await fetch(
      "https://api.upstox.com/v2/login/authorization/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: UPSTOX_API_KEY,
          client_secret: UPSTOX_API_SECRET,
          redirect_uri: UPSTOX_REDIRECT_URI,
          grant_type: "authorization_code",
        }),
      },
    );
    if (!res.ok) {
      // Never include the response body wholesale — it could echo the code.
      throw new Error(`token exchange failed with HTTP ${res.status}`);
    }
    const body = (await res.json()) as { access_token?: string };
    if (!body.access_token) {
      throw new Error("token exchange response had no access_token");
    }
    await this.storeToken(body.access_token);
    this.log.info("access token stored — feed will start automatically");
  }

  async storeToken(token: string, nowUtcMs = Date.now()): Promise<void> {
    const ttl = secondsUntilTokenExpiry(nowUtcMs);
    await this.redis.set(TOKEN_KEY, token, "EX", ttl);
  }

  /** null when unauthenticated or Redis is unreachable. */
  async getToken(): Promise<string | null> {
    try {
      return await this.redis.get(TOKEN_KEY);
    } catch {
      return null;
    }
  }

  async status(): Promise<AuthStatus> {
    try {
      const ttl = await this.redis.ttl(TOKEN_KEY);
      if (ttl <= 0) return { authenticated: false, expiresAt: null };
      return {
        authenticated: true,
        expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
      };
    } catch {
      return { authenticated: false, expiresAt: null };
    }
  }
}
