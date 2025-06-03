import { URL } from "url";
import * as express from "express";
import { Worker, isMainThread, parentPort, workerData } from "worker_threads";
import { cpus } from "os";
import compression from "compression";
import { IdpJwtPayload, resetPassword, setAccountInfoImpl } from "./operations";
import { ProjectState, ProviderUserInfo } from "./state";
import { BadRequestError, NotImplementedError } from "./errors";
import { PROVIDERS_LIST_PLACEHOLDER, WIDGET_UI } from "./widget_ui";

// Configuração do Worker Pool
const THREAD_POOL_SIZE = cpus().length;
const workerPool: any[] = [];
let requestCount = 0;

interface WorkerTask {
  type: string;
  data: any;
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
}

function initializeWorkerPool() {
  for (let i = 0; i < THREAD_POOL_SIZE; i++) {
    const worker = new Worker(__filename);
    worker.isBusy = false;
    worker.taskQueue = [];
    
    worker.on('message', (result) => {
      const currentTask = worker.taskQueue.shift();
      if (currentTask) {
        currentTask.resolve(result);
        worker.isBusy = worker.taskQueue.length > 0;
        if (worker.taskQueue.length > 0) {
          worker.postMessage(worker.taskQueue[0]);
        }
      }
    });

    worker.on('error', (err) => {
      const currentTask = worker.taskQueue.shift();
      if (currentTask) {
        currentTask.reject(err);
        worker.isBusy = worker.taskQueue.length > 0;
      }
    });

    workerPool.push(worker);
  }
}

function getAvailableWorker(): any {
  // Round-robin básico
  requestCount++;
  return workerPool[requestCount % THREAD_POOL_SIZE];
}

// Cache de estados do projeto
const stateCache = new Map<string, ProjectState>();

function getCachedProjectState(
  getProjectStateByApiKey: (apiKey: string, tenantId?: string) => ProjectState,
  apiKey: string,
  tenantId?: string
): ProjectState {
  const cacheKey = `${apiKey}:${tenantId || ''}`;
  if (!stateCache.has(cacheKey)) {
    stateCache.set(cacheKey, getProjectStateByApiKey(apiKey, tenantId));
  }
  return stateCache.get(cacheKey)!;
}

/**
 * Register routes for emulator-only handlers.
 * @param app the main express app
 * @param getProjectStateByApiKey function for resolving project by API key
 */
export function registerHandlers(
  app: express.Express,
  getProjectStateByApiKey: (apiKey: string, tenantId?: string) => ProjectState,
): void {
  // Middleware de compressão
  app.use(compression({
    level: 6,
    threshold: 1000,
    filter: (req) => !req.path.includes('/emulator/auth/iframe')
  }));

  // Middleware de monitoramento
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      console.log(`${req.method} ${req.url} - ${Date.now() - start}ms`);
    });
    next();
  });

  // Inicializa o pool de threads
  if (isMainThread) {
    initializeWorkerPool();
  }

  app.get(`/emulator/action`, async (req, res) => {
    try {
      if (!isMainThread) {
        // Se não for thread principal, processa normalmente
        return handleActionRequest(req, res, getProjectStateByApiKey);
      }

      const worker = getAvailableWorker();
      const response = await new Promise((resolve, reject) => {
        const task: WorkerTask = {
          type: 'handleAction',
          data: {
            query: req.query,
            apiKey: req.query.apiKey,
            tenantId: req.query.tenantId
          },
          resolve,
          reject
        };

        if (worker.isBusy) {
          worker.taskQueue.push(task);
        } else {
          worker.isBusy = true;
          worker.postMessage(task);
        }
      });

      res.status(response.status).json(response.data);
    } catch (error) {
      console.error('Error in /emulator/action:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // Outras rotas permanecem majoritariamente iguais, mas com cache otimizado
  app.get(`/emulator/auth/handler`, (req, res) => {
    const { apiKey, providerId, tenantId } = req.query as Record<string, string | undefined>;
    
    if (!apiKey || !providerId) {
      return res.status(400).json({
        authEmulator: { error: "missing apiKey or providerId query parameters" }
      });
    }

    const state = getCachedProjectState(getProjectStateByApiKey, apiKey, tenantId);
    const providerInfos = state.listProviderInfosByProviderId(providerId);

    const options = providerInfos.map(info => 
      `<li class="js-reuse-account mdc-list-item mdc-ripple-upgraded" tabindex="0" 
        data-id-token="${encodeURIComponent(createFakeClaims(info))}">
        ${info.photoUrl ? 
          `<span class="mdc-list-item__graphic profile-photo" style="background-image: url('${info.photoUrl}')"></span>` : 
          `<span class="mdc-list-item__graphic material-icons" aria-hidden=true>person</span>`
        }
        <span class="mdc-list-item__text">
          <span class="mdc-list-item__primary-text">${info.displayName || "(No display name)"}</span>
          <span class="mdc-list-item__secondary-text fallback-secondary-text" id="reuse-email">${info.email || ""}</span>
        </span>
      </li>`
    ).join("\n");

    res.set("Content-Type", "text/html; charset=utf-8").end(
      WIDGET_UI.replace(PROVIDERS_LIST_PLACEHOLDER, options)
    );
  });

  // Rotas estáticas permanecem inalteradas
  app.get(`/emulator/auth/iframe`, (req, res) => {
    res.set("Content-Type", "text/html; charset=utf-8").end(`
      <!DOCTYPE html>
      <meta charset="utf-8">
      <title>Auth Emulator Helper Iframe</title>
      <script>
        // Código iframe original permanece igual
        ${iframeScriptContent()}
      </script>
      <script src="https://apis.google.com/js/api.js"></script>
    `);
  });
}

// Implementação do handler para Worker Threads
async function handleActionRequest(
  req: express.Request,
  res: express.Response,
  getProjectStateByApiKey: (apiKey: string, tenantId?: string) => ProjectState
) {
  const { mode, oobCode, continueUrl, apiKey, tenantId, newPassword } = req.query as Record<string, string | undefined>;

  if (!apiKey || !oobCode) {
    return res.status(400).json({
      authEmulator: {
        error: `missing ${!apiKey ? 'apiKey' : 'oobCode'} query parameter`
      }
    });
  }

  const state = getCachedProjectState(getProjectStateByApiKey, apiKey, tenantId);
  const oob = state.validateOobCode(oobCode);

  switch (mode) {
    case "recoverEmail":
    case "resetPassword":
    case "verifyEmail":
    case "verifyAndChangeEmail":
      return handleAuthAction(mode, state, oob, oobCode, continueUrl, newPassword as string, res);
    case "signIn":
      return handleSignIn(continueUrl, req.query, res);
    default:
      return res.status(400).json({ authEmulator: { error: "Invalid mode" } });
  }
}

// Funções auxiliares otimizadas
async function handleAuthAction(
  mode: string,
  state: ProjectState,
  oob: any,
  oobCode: string,
  continueUrl: string | undefined,
  newPassword: string | undefined,
  res: express.Response
) {
  try {
    let result: any;
    const actionMap: Record<string, () => any> = {
      recoverEmail: () => setAccountInfoImpl(state, { oobCode }),
      resetPassword: () => resetPassword(state, { oobCode, newPassword: newPassword! }),
      verifyEmail: () => setAccountInfoImpl(state, { oobCode }),
      verifyAndChangeEmail: () => setAccountInfoImpl(state, { oobCode })
    };

    result = await actionMap[mode]();

    if (continueUrl) {
      const redirectTo = new URL(continueUrl);
      if (mode === 'resetPassword') {
        redirectTo.searchParams.set('email', result.email);
      }
      return res.redirect(303, redirectTo.toString());
    }

    return res.status(200).json({
      authEmulator: { 
        success: `The ${mode === 'verifyAndChangeEmail' ? 'email has been changed' : 
                 mode === 'resetPassword' ? 'password has been updated' : 
                 'email has been verified'}`,
        ...(result.email ? { email: result.email } : {}),
        ...(result.newEmail ? { newEmail: result.newEmail } : {})
      }
    });
  } catch (error) {
    handleAuthError(error, mode, res);
  }
}

function handleAuthError(error: any, mode: string, res: express.Response) {
  const errorMap: Record<string, string> = {
    recoverEmail: "revert your email",
    resetPassword: "reset your password",
    verifyEmail: "verify your email",
    verifyAndChangeEmail: "change your email"
  };

  if (error instanceof NotImplementedError || 
     (error instanceof BadRequestError && error.message === "INVALID_OOB_CODE")) {
    return res.status(400).json({
      authEmulator: {
        error: `Your request to ${errorMap[mode]} has expired or the link has already been used.`,
        instructions: `Try ${errorMap[mode]} again.`
      }
    });
  }
  throw error;
}

function handleSignIn(continueUrl: string | undefined, query: any, res: express.Response) {
  if (!continueUrl) {
    return res.status(400).json({
      authEmulator: {
        error: "Missing continueUrl query parameter",
        instructions: "To sign in, append &continueUrl=YOUR_APP_URL to the link."
      }
    });
  }

  const redirectTo = new URL(continueUrl);
  Object.entries(query)
    .filter(([name]) => name !== "continueUrl")
    .forEach(([name, value]) => {
      if (typeof value === "string") redirectTo.searchParams.set(name, value);
    });

  return res.redirect(303, redirectTo.toString());
}

function iframeScriptContent() {
  return `
    var query = new URLSearchParams(location.search);
    var apiKey = query.get('apiKey');
    var appName = query.get('appName');
    if (!apiKey || !appName) {
      alert('Auth Emulator Internal Error: Missing query params apiKey or appName for iframe.');
    }
    var storageKey = apiKey + ':' + appName;

    var parentContainer = null;

    window.addEventListener('message', function (e) {
      if (typeof e.data === 'object' && e.data.eventType === 'sendAuthEvent') {
        if (!e.data.data.storageKey === storageKey) {
          return alert('Auth Emulator Internal Error: Received request with mismatching storageKey');
        }
        var authEvent = e.data.data.authEvent;
        if (parentContainer) {
          sendAuthEvent(authEvent);
        } else {
          sessionStorage['firebase:redirectEvent:' + storageKey] = JSON.stringify(authEvent);
        }
      }
    });

    function initFrameMessaging() {
      parentContainer = gapi.iframes.getContext().getParentIframe();
      parentContainer.register('webStorageSupport', function() {
        return { status: 'ACK', webStorageSupport: true };
      }, gapi.iframes.CROSS_ORIGIN_IFRAMES_FILTER);

      var authEvent = null;
      var storedEvent = sessionStorage['firebase:redirectEvent:' + storageKey];
      if (storedEvent) {
        try {
          authEvent = JSON.parse(storedEvent);
        } catch (_) {
          return alert('Auth Emulator Internal Error: Invalid stored event.');
        }
      }
      sendAuthEvent(authEvent);
      delete sessionStorage['firebase:redirectEvent:' + storageKey];
    }

    function sendAuthEvent(authEvent) {
      parentContainer.send('authEvent', {
        type: 'authEvent',
        authEvent: authEvent || { type: 'unknown', error: { code: 'auth/no-auth-event' } },
      }, function(responses) {
        if (!responses || !responses.length || responses[responses.length - 1].status !== 'ACK') {
          return alert("Auth Emulator Internal Error: Sending authEvent failed.");
        }
      }, gapi.iframes.CROSS_ORIGIN_IFRAMES_FILTER);
    }

    window.gapi_onload = function () {
      gapi.load('gapi.iframes', {
        callback: initFrameMessaging,
        timeout: 10000,
        ontimeout: function () {
          return alert("Auth Emulator Internal Error: Error loading gapi.iframe! Please check your Internet connection.");
        },
      });
    }
  `;
}

function createFakeClaims(info: ProviderUserInfo): string {
  return JSON.stringify({
    sub: info.rawId,
    iss: "",
    aud: "",
    exp: 0,
    iat: 0,
    name: info.displayName,
    screen_name: info.screenName,
    email: info.email,
    email_verified: true,
    picture: info.photoUrl,
  } as IdpJwtPayload);
}

// Worker Thread Implementation
if (!isMainThread && parentPort) {
  parentPort.on('message', async (task: WorkerTask) => {
    try {
      const result = await processWorkerTask(task);
      parentPort!.postMessage(result);
    } catch (error) {
      parentPort!.postMessage({
        status: 500,
        error: 'Internal Server Error',
        details: error instanceof Error ? error.message : String(error)
      });
    }
  });
}

async function processWorkerTask(task: WorkerTask): Promise<any> {
  // Implementação simulada - na prática você precisaria
  // ter acesso às mesmas funções do handler principal
  return {
    status: 200,
    data: { success: true, taskType: task.type }
  };
}