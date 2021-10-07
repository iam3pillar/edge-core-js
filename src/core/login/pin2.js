// @flow

import { uncleaner } from 'cleaners'

import { asChangePin2Payload } from '../../types/server-cleaners.js'
import { type LoginRequestBody } from '../../types/server-types.js'
import { type EdgeAccountOptions } from '../../types/types.js'
import { decrypt, encrypt } from '../../util/crypto/crypto.js'
import { hmacSha256 } from '../../util/crypto/hashes.js'
import { utf8 } from '../../util/encoding.js'
import { type ApiInput } from '../root-pixie.js'
import { applyKits, searchTree, serverLogin } from './login.js'
import { loginFetch } from './login-fetch.js'
import { fixUsername, getStash } from './login-selectors.js'
import { type LoginStash } from './login-stash.js'
import { type LoginKit, type LoginTree } from './login-types.js'
import { getLoginOtp } from './otp.js'

const wasChangePin2Payload = uncleaner(asChangePin2Payload)

function pin2Id(pin2Key: Uint8Array, username: string): Uint8Array {
  const data = utf8.parse(fixUsername(username))
  return hmacSha256(data, pin2Key)
}

function pin2Auth(pin2Key: Uint8Array, pin: string): Uint8Array {
  return hmacSha256(utf8.parse(pin), pin2Key)
}

/**
 * Returns a copy of the PIN login key if one exists on the local device.
 */
export function findPin2Stash(
  stashTree: LoginStash,
  appId: string
): LoginStash | void {
  if (stashTree.pin2Key != null) return stashTree
  const stash = searchTree(stashTree, stash => stash.appId === appId)
  if (stash != null && stash.pin2Key != null) return stash
}

/**
 * Logs a user in using their PIN.
 * @return A `Promise` for the new root login.
 */
export async function loginPin2(
  ai: ApiInput,
  appId: string,
  username: string,
  pin: string,
  opts: EdgeAccountOptions
): Promise<LoginTree> {
  // Find the stash to use:
  const stashTree = getStash(ai, username)
  const stash = findPin2Stash(stashTree, appId)
  if (stash == null || stash.pin2Key == null) {
    throw new Error('PIN login is not enabled for this account on this device')
  }

  // Request:
  const { pin2Key } = stash
  const request = {
    pin2Id: pin2Id(pin2Key, username),
    pin2Auth: pin2Auth(pin2Key, pin)
  }
  return serverLogin(ai, stashTree, stash, opts, request, async reply => {
    if (reply.pin2Box == null) {
      throw new Error('Missing data for PIN v2 login')
    }
    return decrypt(reply.pin2Box, pin2Key)
  })
}

export async function changePin(
  ai: ApiInput,
  accountId: string,
  pin: string | void,
  enableLogin: boolean | void
): Promise<void> {
  const { loginTree, username } = ai.props.state.accounts[accountId]

  // Figure out defaults:
  if (enableLogin == null) {
    enableLogin =
      loginTree.pin2Key != null || (pin != null && loginTree.pin == null)
  }
  if (pin == null) pin = loginTree.pin

  // We cannot enable PIN login if we don't know the PIN:
  if (pin == null) {
    if (enableLogin) {
      throw new Error(
        'Please change your PIN in the settings area above before enabling.'
      )
    }
    // But we can disable PIN login by just deleting it entirely:
    await applyKits(ai, loginTree, makeDeletePin2Kits(loginTree))
    return
  }

  const kits = makeChangePin2Kits(ai, loginTree, username, pin, enableLogin)
  await applyKits(ai, loginTree, kits)
}

/**
 * Returns true if the given pin is correct.
 */
export async function checkPin2(
  ai: ApiInput,
  login: LoginTree,
  pin: string
): Promise<boolean> {
  const { appId, username } = login
  if (username == null) return false

  // Find the stash to use:
  const stashTree = getStash(ai, username)
  const stash = findPin2Stash(stashTree, appId)
  if (stash == null || stash.pin2Key == null) {
    throw new Error('No PIN set locally for this account')
  }

  // Try a login:
  const { pin2Key } = stash
  const request: LoginRequestBody = {
    pin2Id: pin2Id(pin2Key, username),
    pin2Auth: pin2Auth(pin2Key, pin),
    otp: getLoginOtp(login)
  }
  return loginFetch(ai, 'POST', '/v2/login', request).then(
    good => true,
    bad => false
  )
}

export async function deletePin(
  ai: ApiInput,
  accountId: string
): Promise<void> {
  const { loginTree } = ai.props.state.accounts[accountId]

  const kits = makeDeletePin2Kits(loginTree)
  await applyKits(ai, loginTree, kits)
}

/**
 * Creates the data needed to attach a PIN to a tree of logins.
 */
export function makeChangePin2Kits(
  ai: ApiInput,
  loginTree: LoginTree,
  username: string,
  pin: string,
  enableLogin: boolean
): LoginKit[] {
  const out: LoginKit[] = [
    makeChangePin2Kit(ai, loginTree, username, pin, enableLogin)
  ]

  if (loginTree.children) {
    for (const child of loginTree.children) {
      out.push(...makeChangePin2Kits(ai, child, username, pin, enableLogin))
    }
  }

  return out
}

/**
 * Creates the data needed to attach a PIN to a login.
 */
export function makeChangePin2Kit(
  ai: ApiInput,
  login: LoginTree,
  username: string,
  pin: string,
  enableLogin: boolean
): LoginKit {
  const { io } = ai.props
  const pin2TextBox = encrypt(io, utf8.parse(pin), login.loginKey)

  if (enableLogin) {
    const pin2Key = login.pin2Key || io.random(32)
    const pin2Box = encrypt(io, login.loginKey, pin2Key)
    const pin2KeyBox = encrypt(io, pin2Key, login.loginKey)

    return {
      serverPath: '/v2/login/pin2',
      server: wasChangePin2Payload({
        pin2Id: pin2Id(pin2Key, username),
        pin2Auth: pin2Auth(pin2Key, pin),
        pin2Box,
        pin2KeyBox,
        pin2TextBox
      }),
      stash: {
        pin2Key,
        pin2TextBox
      },
      login: {
        pin2Key,
        pin
      },
      loginId: login.loginId
    }
  } else {
    return {
      serverPath: '/v2/login/pin2',
      server: wasChangePin2Payload({
        pin2Id: undefined,
        pin2Auth: undefined,
        pin2Box: undefined,
        pin2KeyBox: undefined,
        pin2TextBox
      }),
      stash: {
        pin2Key: undefined,
        pin2TextBox
      },
      login: {
        pin2Key: undefined,
        pin
      },
      loginId: login.loginId
    }
  }
}

/**
 * Creates the data needed to delete a PIN from a tree of logins.
 */
export function makeDeletePin2Kits(loginTree: LoginTree): LoginKit[] {
  const out: LoginKit[] = [makeDeletePin2Kit(loginTree)]

  if (loginTree.children) {
    for (const child of loginTree.children) {
      out.push(...makeDeletePin2Kits(child))
    }
  }

  return out
}

/**
 * Creates the data needed to delete a PIN from a login.
 */
export function makeDeletePin2Kit(login: LoginTree): LoginKit {
  return {
    serverMethod: 'DELETE',
    serverPath: '/v2/login/pin2',
    server: undefined,
    stash: {
      pin2Key: undefined
    },
    login: {
      pin2Key: undefined
    },
    loginId: login.loginId
  }
}
