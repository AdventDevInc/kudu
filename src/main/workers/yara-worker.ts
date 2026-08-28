import { parentPort } from 'worker_threads'
import { YaraEngine } from '../services/yara-engine'

if (!parentPort) {
  throw new Error('YARA worker must be launched as a worker thread')
}

const engine = new YaraEngine({ background: false })

interface WorkerRequest {
  id: number
  type: 'load-rules' | 'scan-file' | 'dispose'
  ruleFilePaths?: string[]
  extraSources?: string[]
  filePath?: string
}

async function handleRequest(request: WorkerRequest): Promise<void> {
  try {
    if (request.type === 'load-rules') {
      const result = await engine.loadRules(
        request.ruleFilePaths ?? [],
        request.extraSources ?? [],
        (loaded, total) => parentPort!.postMessage({
          type: 'progress',
          id: request.id,
          loaded,
          total,
        }),
      )
      parentPort!.postMessage({ type: 'result', id: request.id, result })
      return
    }

    if (request.type === 'scan-file') {
      const result = request.filePath ? engine.scanFile(request.filePath) : []
      parentPort!.postMessage({ type: 'result', id: request.id, result })
      return
    }

    engine.dispose()
    parentPort!.postMessage({ type: 'result', id: request.id, result: null })
  } catch (error) {
    parentPort!.postMessage({
      type: 'error',
      id: request.id,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

engine.initialize()
  .then(() => {
    parentPort!.on('message', (request: WorkerRequest) => {
      void handleRequest(request)
    })
    parentPort!.postMessage({ type: 'ready' })
  })
  .catch((error) => {
    parentPort!.postMessage({
      type: 'startup-error',
      error: error instanceof Error ? error.message : String(error),
    })
  })
