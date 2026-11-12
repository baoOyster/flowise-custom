import { ChatOpenAI } from '@langchain/openai'
import { StatusCodes } from 'http-status-codes'
import { IChatProvider } from './types'
import { getCredentialApiKey, toLangChainMessages } from './utils'
import { InternalFlowiseError } from '../../../errors/internalFlowiseError'
import { getErrorMessage } from '../../../errors/utils'

export class OpenAIProvider implements IChatProvider {
    readonly id = 'openai' as const
    readonly name = 'OpenAI'
    readonly type = 'cloud' as const
    readonly credentialName = 'openAIApi' as const
    readonly defaultModels = ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o1-mini', 'o3-mini']

    async getModels(_config: { url?: string; credentialId?: string }): Promise<string[]> {
        return this.defaultModels
    }

    async invoke(
        messages: Array<{ role: string; content: string }>,
        config: { model: string; url?: string; credentialId?: string }
    ): Promise<string> {
        if (!config.credentialId) {
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'OpenAI credential required but not selected')
        }

        try {
            const openAIApiKey = await getCredentialApiKey(config.credentialId, 'openAIApiKey', 'OpenAI')
            const model = new ChatOpenAI({
                openAIApiKey,
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
            throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, `OpenAI invocation failed: ${getErrorMessage(error)}`)
        }
    }
}
