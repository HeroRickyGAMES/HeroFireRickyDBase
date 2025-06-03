import * as chokidar from "chokidar";
import * as fs from "fs";
import * as clc from "colorette";
import * as path from "path";
import * as utils from "../utils";
import * as downloadableEmulators from "./downloadableEmulators";
import { EmulatorInfo, EmulatorInstance, Emulators, Severity } from "../emulator/types";
import { EmulatorRegistry } from "./registry";
import { Constants } from "./constants";
import { Issue } from "./types";
import { Worker, isMainThread, parentPort, workerData } from "worker_threads";
import cluster from 'cluster';
import os from 'os';

export interface FirestoreEmulatorArgs {
  port?: number;
  host?: string;
  websocket_port?: number;
  project_id?: string;
  rules?: string;
  functions_emulator?: string;
  auto_download?: boolean;
  seed_from_export?: string;
  single_project_mode?: boolean;
  single_project_mode_error?: boolean;
  persistence_path?: string; // Adicione esta linha
}

export interface FirestoreEmulatorInfo extends EmulatorInfo {
  webSocketHost?: string;
  webSocketPort?: number;
}

export class FirestoreEmulator implements EmulatorInstance {
  private persistencePath: string | undefined;
  private persistenceData: any; // Você pode tipar isso melhor conforme sua necessidade

  rulesWatcher?: chokidar.FSWatcher;
  private readCache: string | null = null; // Adicionando a propriedade para cache

  constructor(private args: FirestoreEmulatorArgs) {}

  async start(): Promise<void> {
    if (cluster.isPrimary) {
      // Mestre: cria workers para cada núcleo
     os.cpus().forEach(() => cluster.fork());
     return;
   }

    // Código do worker...
    if (EmulatorRegistry.isRunning(Emulators.FUNCTIONS)) {
      this.args.functions_emulator = EmulatorRegistry.url(Emulators.FUNCTIONS).host;
    }

    if (EmulatorRegistry.isRunning(Emulators.FUNCTIONS)) {
      this.args.functions_emulator = EmulatorRegistry.url(Emulators.FUNCTIONS).host;
    }

    if (this.args.rules && this.args.project_id) {
      const rulesPath = this.args.rules;
      this.rulesWatcher = chokidar.watch(rulesPath, { persistent: true, ignoreInitial: true });

      this.rulesWatcher.on("change", async () => {
        await new Promise((res) => setTimeout(res, 5)); // Previne a leitura muito rápida do arquivo

        utils.logLabeledBullet("firestore", "Change detected, updating rules...");
        const newContent = await this.readFileWithCache(rulesPath);

        // Atualiza regras usando Worker Threads
        this.updateRulesInWorker(newContent);
      });
    }

    return downloadableEmulators.start(Emulators.FIRESTORE, this.args);
  }

  connect(): Promise<void> {
    return Promise.resolve();
  }

    private setupPersistence(pathe: string) {
    this.persistencePath = pathe;
    
    // Usando fs-extra que tem existsSync e mkdirp
    if (!fs.existsSync(pathe)) {
      fs.mkdirSync(pathe, { recursive: true });
    }

    // Carrega dados existentes
    const dataFile = path.join(pathe, 'firestore-data.json');
    if (fs.existsSync(dataFile)) {
      try {
        this.persistenceData = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
        utils.logLabeledBullet('firestore', `Loaded persistent data from ${dataFile}`);
      } catch (e) {
        utils.logWarning(`Failed to load persistent data: ${e}`);
        this.persistenceData = {};
      }
    }
  }

  private async savePersistentData() {
    if (!this.persistencePath) return;
    
    const dataFile = path.join(this.persistencePath, `firestore-data-${process.pid}.json`);
    try {
      // Versão assíncrona
      await fs.promises.writeFile(dataFile, JSON.stringify(this.persistenceData));
      console.log(`[Worker ${process.pid}] Persisted data to ${dataFile}`);
    } catch (e) {
      console.error(`[Worker ${process.pid}] Failed to persist data: ${e}`);
    }
  }

  stop(): Promise<void> {
    if (this.rulesWatcher) {
      this.rulesWatcher.close();
    }

    return downloadableEmulators.stop(Emulators.FIRESTORE);
  }

  getInfo(): FirestoreEmulatorInfo {
    const host = this.args.host || Constants.getDefaultHost();
    const port = this.args.port || Constants.getDefaultPort(Emulators.FIRESTORE);
    const reservedPorts = this.args.websocket_port ? [this.args.websocket_port] : [];

    return {
      name: this.getName(),
      host,
      port,
      pid: downloadableEmulators.getPID(Emulators.FIRESTORE),
      reservedPorts: reservedPorts,
      webSocketHost: this.args.websocket_port ? host : undefined,
      webSocketPort: this.args.websocket_port ? this.args.websocket_port : undefined,
    };
  }

  getName(): Emulators {
    return Emulators.FIRESTORE;
  }

  // Função otimizada para ler arquivos com cache
  private async readFileWithCache(filePath: string): Promise<string> {
    if (!this.readCache) {
      this.readCache = fs.readFileSync(filePath, "utf8").toString();
    }
    return this.readCache;
  }

  // Atualiza regras usando Worker Threads
  private updateRulesInWorker(content: string): void {
    if (isMainThread) {
      // Se estiver no thread principal, cria o Worker
      const worker = new Worker(__filename, {
        workerData: {
          content,
          projectId: this.args.project_id,
        },
      });

      worker.on("message", (issues: Issue[]) => {
        if (issues) {
          issues.forEach((issue) => {
            utils.logWarning(this.prettyPrintRulesIssue(this.args.rules!, issue));
          });
        }
        if (issues?.some((issue) => issue.severity === Severity.ERROR)) {
          utils.logWarning("Failed to update rules");
        } else {
          utils.logLabeledSuccess("firestore", "Rules updated.");
        }
      });

      worker.on("error", (err) => {
        utils.logWarning("Worker failed: " + err.message);
      });

      worker.on("exit", (code) => {
        if (code !== 0) {
          utils.logWarning(`Worker stopped with exit code ${code}`);
        }
      });
    }
  }

  // Função chamada no Worker Thread
  public static async processRulesUpdate(content: string, projectId: string): Promise<Issue[]> {
    return this.updateRules(content, projectId);  // Retorna os issues
  }

  // Atualiza as regras diretamente no Firestore Emulator
  private static async updateRules(content: string, projectId: string): Promise<Issue[]> {
    const body = {
      ignore_errors: true,
      rules: {
        files: [
          {
            name: "security.rules",
            content,
          },
        ],
      },
    };

    const res = await EmulatorRegistry.client(Emulators.FIRESTORE).put<any, { issues?: Issue[] }>(
      `/emulator/v1/projects/${projectId}:securityRules`,
      body,
    );
    return res.body?.issues || [];
  }

  // Função para formatação das mensagens de erro de regras
  private prettyPrintRulesIssue(filePath: string, issue: Issue): string {
    const relativePath = path.relative(process.cwd(), filePath);
    const line = issue.sourcePosition.line || 0;
    const col = issue.sourcePosition.column || 0;
    return `${clc.cyan(relativePath)}:${clc.yellow(line)}:${clc.yellow(col)} - ${clc.red(
      issue.severity,
    )} ${issue.description}`;
  }
}

// Se não estiver no thread principal, executa o Worker Thread
if (!isMainThread) {
  const { content, projectId } = workerData;
  FirestoreEmulator.processRulesUpdate(content, projectId).then((issues) => {
    parentPort?.postMessage(issues);  // Envia os issues de volta ao thread principal
  });
}
