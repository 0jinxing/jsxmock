import http from 'http'
import https from 'https'
import path from 'path'
import cors from 'cors'
import os from 'os'
import multer from 'multer'
import express from 'express'
import isEqual from 'lodash/isEqual'
import sockjs, { Connection } from 'sockjs'
import { runMiddlewares } from './runner'
import { ServiceConfig, WebSocketConfig } from './type'
import genCert from './utils/cert'

const DEFAULT_PORT = 4321
const DEFAULT_HOST = '0.0.0.0'
const DEFAULT_HTTPS = false

let running = false
let currentConfig: ServiceConfig
let server: http.Server | https.Server
let registerSockHandlers: { [prefix: string]: WebSocketConfig } = {}

export function patchServer(config: ServiceConfig) {
  if (!running) {
    runServer(config)
  } else if (!isEqual(config.server, currentConfig.server) && server) {
    console.info('hard restart server')
    server.close(() => {
      registerSockHandlers = {}
      runServer(config)
    })
  } else {
    // hot patch
    console.info('hot patch')
    currentConfig = config
    attachSockjs(config.ws)
  }
}

function handleSockConnect(path: string, conn: Connection) {
  console.info('websocket connected: ' + path)
  const cf = registerSockHandlers[path]
  if (cf == null) {
    conn.close('1000', 'Not Handler')
    return
  }

  cf.onConnect?.(conn)

  conn.on('data', message => {
    cf.onMessage?.(message, conn)
  })

  conn.on('close', () => {
    cf.onClose?.()
  })
}

function attachSockjs(ws: ServiceConfig['ws']) {
  ws.forEach((cf, path) => {
    if (path in registerSockHandlers) {
      registerSockHandlers[path] = cf
      return
    }

    // attach
    registerSockHandlers[path] = cf
    const sockSrv = sockjs.createServer({})
    sockSrv.installHandlers(server, { prefix: path })
    sockSrv.on('connection', handleSockConnect.bind(null, path))
  })
}

export function runServer(config: ServiceConfig) {
  console.info('starting server...')
  running = true
  currentConfig = config
  const {
    port = DEFAULT_PORT,
    host = DEFAULT_HOST,
    https: enableHTTPS = DEFAULT_HTTPS,
    prefix = '/',
  } = currentConfig.server

  // TODO: 端口查找
  const app = express()
  const mul = multer({
    dest: path.join(os.tmpdir(), 'jsxmock'),
  })

  app.use(cors())
  app.use(express.json())
  app.use(express.urlencoded({ extended: true }))
  app.use(mul.any())

  // TODO: 日志
  app.use((req, res, next) => {
    console.info(`${req.method} ${req.path}`)
    next()
  })

  const router = express.Router()

  router.use(async (req, res, next) => {
    try {
      const hit = await runMiddlewares(req, res, currentConfig.middlewares)

      if (!hit) {
        console.warn(`${req.method} ${req.path} 请求未命中任何模拟器`)
        next()
      }
    } catch (err) {
      console.error('failed to runMiddlewares:')
      console.error(err)
      if (!res.headersSent) {
        res.status(500)
        res.send(err.message)
      }
    }
  })

  app.use(prefix, router)

  if (enableHTTPS) {
    const cert = genCert()
    server = https.createServer(
      {
        key: cert,
        cert: cert,
      },
      app,
    )
  } else {
    server = http.createServer(app)
  }

  attachSockjs(currentConfig.ws)

  server.listen(port, host, () => {
    console.log(
      `JSXMock 服务器已启动: ${
        enableHTTPS ? 'https' : 'http'
      }://${host}:${port}`,
    )
  })
}
