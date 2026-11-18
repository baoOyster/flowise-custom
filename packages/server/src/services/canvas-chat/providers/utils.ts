import { StatusCodes } from 'http-status-codes'
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
