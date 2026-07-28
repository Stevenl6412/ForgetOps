import { createHash, randomBytes } from "node:crypto";

export interface MagicLinkAdapter {
  sendMagicLink(input: {
    challengeId: string;
    challengeUrl: string;
  }): Promise<void> | void;
  verifyMagicLink(input: { token: string }): Promise<boolean> | boolean;
}

interface MagicLinkChallenge {
  id: string;
  projectId: string;
  expiresAt: string;
  consumedAt: string | null;
  tokenHash: string;
}

export class MagicLinkError extends Error {
  constructor(
    readonly code:
      "MAGIC_LINK_INVALID" | "MAGIC_LINK_EXPIRED" | "MAGIC_LINK_REPLAYED",
  ) {
    super(code);
    this.name = "MagicLinkError";
  }
}

export class MagicLinkService {
  private readonly challenges = new Map<string, MagicLinkChallenge>();

  constructor(
    private readonly adapter: MagicLinkAdapter,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(input: {
    projectId: string;
    portalBaseUrl: string;
    ttlMs?: number;
  }): Promise<{ challengeId: string; token: string; challengeUrl: string }> {
    const ttlMs = input.ttlMs ?? 15 * 60 * 1000;
    if (ttlMs <= 0 || ttlMs > 30 * 60 * 1000) {
      throw new MagicLinkError("MAGIC_LINK_INVALID");
    }
    const challengeId = randomBytes(16).toString("hex");
    const token = randomBytes(32).toString("base64url");
    const challengeUrl = new URL(
      `/portal/verify?challenge=${challengeId}&token=${token}`,
      input.portalBaseUrl,
    ).toString();
    this.challenges.set(challengeId, {
      id: challengeId,
      projectId: input.projectId,
      expiresAt: new Date(this.now().getTime() + ttlMs).toISOString(),
      consumedAt: null,
      tokenHash: digest(token),
    });
    await this.adapter.sendMagicLink({ challengeId, challengeUrl });
    return { challengeId, token, challengeUrl };
  }

  async consume(input: {
    challengeId: string;
    token: string;
  }): Promise<{ projectId: string }> {
    const challenge = this.challenges.get(input.challengeId);
    if (!challenge || challenge.tokenHash !== digest(input.token)) {
      throw new MagicLinkError("MAGIC_LINK_INVALID");
    }
    if (challenge.consumedAt) {
      throw new MagicLinkError("MAGIC_LINK_REPLAYED");
    }
    if (Date.parse(challenge.expiresAt) <= this.now().getTime()) {
      throw new MagicLinkError("MAGIC_LINK_EXPIRED");
    }
    if (!(await this.adapter.verifyMagicLink({ token: input.token }))) {
      throw new MagicLinkError("MAGIC_LINK_INVALID");
    }
    challenge.consumedAt = this.now().toISOString();
    return { projectId: challenge.projectId };
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
