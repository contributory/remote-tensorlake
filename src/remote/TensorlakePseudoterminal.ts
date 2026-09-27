import { StringDecoder } from "node:string_decoder";
import * as vscode from "vscode";
import {
  createTensorlakePty,
  TensorlakePtySession,
} from "../tensorlake/pty";
import { DEFAULT_TENSORLAKE_WORKSPACE } from "./uri";

export class TensorlakePseudoterminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<number | void>();
  private readonly decoder = new StringDecoder("utf8");
  private session: TensorlakePtySession | undefined;
  private dimensions: vscode.TerminalDimensions | undefined;
  private pendingInput: string[] = [];
  private disposed = false;
  private closed = false;

  readonly onDidWrite = this.writeEmitter.event;
  readonly onDidClose = this.closeEmitter.event;

  constructor(
    private readonly sandboxId: string,
    private readonly workingDir = DEFAULT_TENSORLAKE_WORKSPACE,
  ) {}

  open(initialDimensions: vscode.TerminalDimensions | undefined): void {
    this.dimensions = initialDimensions;
    void this.connect();
  }

  close(): void {
    this.disposed = true;
    const session = this.session;
    this.session = undefined;
    if (session) {
      void session.kill().catch(() => undefined);
    }
    this.writeEmitter.dispose();
    this.closeEmitter.dispose();
  }

  handleInput(data: string): void {
    if (this.session) {
      this.session.sendInput(data);
    } else {
      this.pendingInput.push(data);
    }
  }

  setDimensions(dimensions: vscode.TerminalDimensions): void {
    this.dimensions = dimensions;
    this.session?.resize(dimensions.columns, dimensions.rows);
  }

  private async connect(): Promise<void> {
    try {
      const session = await createTensorlakePty(this.sandboxId, {
        workingDir: this.workingDir,
        cols: this.dimensions?.columns,
        rows: this.dimensions?.rows,
      });

      if (this.disposed) {
        await session.kill().catch(() => undefined);
        return;
      }

      this.session = session;
      session.onData((data) => {
        const text = this.decoder.write(Buffer.from(data));
        if (text) {
          this.writeEmitter.fire(text);
        }
      });
      session.onExit((exitCode) => {
        this.session = undefined;
        this.finish(exitCode);
      });

      for (const input of this.pendingInput) {
        session.sendInput(input);
      }
      this.pendingInput = [];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.writeEmitter.fire(
        `\r\n[Tensorlake terminal error] ${message}\r\n`,
      );
      this.finish(1);
    }
  }

  private finish(exitCode: number): void {
    if (this.closed || this.disposed) {
      return;
    }
    this.closed = true;
    const tail = this.decoder.end();
    if (tail) {
      this.writeEmitter.fire(tail);
    }
    this.closeEmitter.fire(exitCode);
  }
}

export function openTensorlakeTerminal(
  sandboxId: string,
  workingDir = DEFAULT_TENSORLAKE_WORKSPACE,
): vscode.Terminal {
  const terminal = vscode.window.createTerminal({
    name: `Tensorlake: ${sandboxId}`,
    pty: new TensorlakePseudoterminal(sandboxId, workingDir),
  });
  terminal.show();
  return terminal;
}
