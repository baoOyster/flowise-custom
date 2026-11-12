import { ChatGroq } from '@langchain/groq'
import { StatusCodes } from 'http-status-codes'
import { IChatProvider } from './types'
import { getCredentialApiKey, toLangChainMessages } from './utils'
import { InternalFlowiseError } from '../../../errors/internalFlowiseError'
import { getErrorMessage } from '../../../errors/utils'

export class GroqProvider implements IChatProvider {
    readonly id = 'groq' as const
    readonly name = 'Groq'
    readonly type = 'cloud' as const
    readonly credentialName = 'groqApi' as const
    readonly defaultModels = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768', 'deepseek-r1-distill-llama-70b']

    async getModels(_config: { url?: string; credentialId?: string }): Promise<string[]> {
        return this.defaultModels
    }

    async invoke(
        messages: Array<{ role: string; content: string }>,
        config: { model: string; url?: string; credentialId?: string }
    ): Promise<string> {
        if (!config.credentialId) {
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Groq credential required but not selected')
        }

        try {
            const groqApiKey = await getCredentialApiKey(config.credentialId, 'groqApiKey', 'Groq')
            const model = new ChatGroq({
                apiKey: groqApiKey,
                modelName: config.model || this.defaultModels[0],
                temperature: 0.7
            })

            const langchainMessages = toLangChainMessages(messages)
            const response = await model.invoke(langchainMessages)
            return (typeof response.content === 'string' ? response.content : JSON.stringify(response.content)) || ''
        } catch (error) {
            if (error instanceof InternalFlowiseError) {
                throw error
            }
            throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, `Groq invocation failed: ${getErrorMessage(error)}`)
        }
    }
}
