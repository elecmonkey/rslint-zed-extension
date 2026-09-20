export interface LintWorkerOptions {
  readonly coreDir: string;
  readonly configPath?: string;
}

export function runLintWorker(options: LintWorkerOptions): Promise<number>;
