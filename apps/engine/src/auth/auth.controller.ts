import { Controller, Get, Inject, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { createLogger } from "../logger";
import { AuthService, type AuthStatus } from "./auth.service";

/**
 * Morning OAuth dance (SPEC §12.2):
 *   /auth/login → Upstox dialog → /auth/upstox/callback → token in Redis.
 */
@Controller("auth")
export class AuthController {
  private readonly log = createLogger("auth-http");

  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Get("login")
  login(@Res() res: Response): void {
    res.redirect(302, this.auth.loginUrl());
  }

  @Get("upstox/callback")
  async callback(
    @Query("code") code: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    if (!code) {
      res.status(400).send("Missing ?code= from Upstox redirect.");
      return;
    }
    try {
      await this.auth.exchangeCode(code);
      res
        .status(200)
        .send(
          "<html><body><h3>Authenticated — engine starting.</h3>" +
            "<p>You can close this tab. The feed connects automatically.</p>" +
            "</body></html>",
        );
    } catch (err) {
      this.log.error({ err: (err as Error).message }, "token exchange failed");
      res.status(502).send("Token exchange failed — check engine logs.");
    }
  }

  @Get("status")
  async status(): Promise<AuthStatus> {
    return this.auth.status();
  }
}
