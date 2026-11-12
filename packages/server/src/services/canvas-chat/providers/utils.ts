import { StatusCodes } from 'http-status-codes'
import { SystemMessage, HumanMessage, AIMessage, BaseMessage } from '@langchain/core/messages'
import { InternalFlowiseError } from '../../../errors/internalFlowiseError'

export const getCredentialApiKey = async (credentialId: string, keyName: string, providerName: string): Promise<string> => {
    if (!credentialId) {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, `${providerName} credential required but not selected`)
    }

    // Static top-level import cannot work here: getRunningExpressApp statically imports server index.ts,
    // creating a circular dependency during module evaluation (route -> controller -> service -> provider -> index -> routes).
    const { getRunningExpressApp } = require('../../../utils/getRunningExpressApp')
    const { decryptCredentialData } = require('../../../utils')
    const { Credential } = require('../../../database/entities/Credential')

    const appServer = getRunningExpressApp()
    const credential = await appServer.AppDataSource.getRepository(Credential).findOneBy({
        id: credentialId
    })

    if (!credential) {
        throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Credential ${credentialId} not found`)
    }

    const decryptedCredentialData = await decryptCredentialData(credential.encryptedData)
    const apiKey = decryptedCredentialData[keyName]
    if (!apiKey) {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, `${providerName} API key (${keyName}) not found in credential`)
    }

    return apiKey
}

export const toLangChainMessages = (messages: Array<{ role: string; content: string }>): BaseMessage[] => {
    return (messages || []).map((m) => {
        const role = (m.role || '').toLowerCase()
        if (role === 'system') return new SystemMessage(m.content || '')
        if (role === 'assistant' || role === 'ai') return new AIMessage(m.content || '')
        return new HumanMessage(m.content || '')
    })
}
