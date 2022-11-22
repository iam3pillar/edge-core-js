// @flow

import { makeSyncClient } from 'edge-sync-client'
import { type StoreEnhancer, compose, createStore } from 'redux'
import { type ReduxProps, attachPixie, filterPixie } from 'redux-pixies'
import { emit } from 'yaob'

import {
  type EdgeContext,
  type EdgeContextOptions,
  type EdgeRateHint
} from '../types/types.js'
import { type RootAction } from './actions.js'
import { CLIENT_FILE_NAME, clientFile } from './context/client-file.js'
import { type LogBackend, filterLogs, makeLog } from './log/log.js'
import { loadStashes } from './login/login-stash.js'
import { type PluginIos, watchPlugins } from './plugins/plugins-actions.js'
import { type RootProps, rootPixie } from './root-pixie.js'
import { type RootState, defaultLogSettings, reducer } from './root-reducer.js'

let allContexts: EdgeContext[] = []

const composeEnhancers =
  typeof window === 'object' &&
  window.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__ != null
    ? window.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__({ name: 'core' })
    : compose

/**
 * Creates the root object for the entire core state machine.
 * This core object contains the `io` object, context options,
 * Redux store, and tree of background workers.
 */
export async function makeContext(
  ios: PluginIos,
  logBackend: LogBackend,
  opts: EdgeContextOptions
): Promise<EdgeContext> {
  const { io } = ios
  const {
    apiKey,
    appId = '',
    authServer = 'https://login.edge.app/api',
    deviceDescription = null,
    hideKeys = false,
    plugins: pluginsInit = {}
  } = opts
  const logSettings = { ...defaultLogSettings, ...opts.logSettings }
  if (apiKey == null) {
    throw new Error('No API key provided')
  }

  validateServer(authServer)

  // Create a redux store:
  const enhancers: StoreEnhancer<RootState, RootAction> = composeEnhancers()
  const redux = createStore(reducer, enhancers)

  // Create a log wrapper, using the settings from redux:
  logBackend = filterLogs(logBackend, () => {
    const state = redux.getState()
    return state.ready ? state.logSettings : logSettings
  })
  const log = makeLog(logBackend, 'edge-core')

  // Load the clientId from disk:
  let clientInfo = await clientFile.load(io.disklet, CLIENT_FILE_NAME)
  if (clientInfo == null) {
    clientInfo = { clientId: io.random(16) }
    await clientFile.save(io.disklet, CLIENT_FILE_NAME, clientInfo)
  }

  // Load the rate hint cache from disk:
  const rateHintCache: EdgeRateHint[] = await io.disklet
    .getText('rateHintCache.json')
    .then(text => JSON.parse(text))
    .catch(() => [])

  // Load the login stashes from disk:
  const stashes = await loadStashes(io.disklet, log)
  redux.dispatch({
    type: 'INIT',
    payload: {
      apiKey,
      appId,
      authServer,
      clientId: clientInfo.clientId,
      deviceDescription,
      hideKeys,
      logSettings,
      pluginsInit,
      rateHintCache,
      stashes
    }
  })

  // Subscribe to new plugins:
  const closePlugins = watchPlugins(
    ios,
    logBackend,
    pluginsInit,
    redux.dispatch
  )

  // Create sync client:
  const syncClient = await makeSyncClient({ log, fetch: io.fetch })

  // Start the pixie tree:
  const mirror = { output: {} }
  const closePixie = attachPixie(
    redux,
    filterPixie(
      rootPixie,
      (props: ReduxProps<RootState, RootAction>): RootProps => ({
        ...props,
        close() {
          closePixie()
          closePlugins()
          redux.dispatch({ type: 'CLOSE' })
        },
        io,
        log,
        logBackend,
        onError: error => {
          if (mirror.output.context?.api != null) {
            emit(mirror.output.context.api, 'error', error)
          }
        },
        syncClient
      })
    ),
    error => log.error(error),
    output => (mirror.output = output)
  )

  const out = mirror.output.context.api
  allContexts.push(out)
  return out
}

/**
 * We use this for unit testing, to kill all core contexts.
 */
export function closeEdge(): void {
  for (const context of allContexts) context.close().catch(() => {})
  allContexts = []
}

/**
 * We only accept *.edge.app or localhost as valid domain names.
 */
export function validateServer(server: string): void {
  const url = new URL(server)

  if (url.protocol === 'http:') {
    if (url.hostname === 'localhost') return
  }
  if (url.protocol === 'https:') {
    if (url.hostname === 'localhost') return
    if (/^([A-Za-z0-9_-]+\.)*edge(test)?\.app$/.test(url.hostname)) return
  }

  throw new Error(
    `Only *.edge.app or localhost are valid login domain names, not ${url.hostname}`
  )
}
