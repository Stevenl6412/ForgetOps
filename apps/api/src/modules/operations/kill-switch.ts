export class ExecutionKillSwitch {
  private paused = false;
  private reason: string | null = null;

  isExecutionPaused(): boolean {
    return this.paused;
  }

  pause(reason: string): void {
    if (!/^[a-z0-9][a-z0-9_:-]{0,127}$/i.test(reason)) {
      throw new RangeError("KILL_SWITCH_REASON_INVALID");
    }
    this.paused = true;
    this.reason = reason;
  }

  resume(): void {
    this.paused = false;
    this.reason = null;
  }

  status(): { paused: boolean; reason: string | null } {
    return { paused: this.paused, reason: this.reason };
  }
}
