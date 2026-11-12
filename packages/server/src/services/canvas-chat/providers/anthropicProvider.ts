import { ChatAnthropic } from '@langchain/anthropic'
import { StatusCodes } from 'http-status-codes'
import { IChatProvider } from './types'
import { getCredentialApiKey, toLangChainMessages } from './utils'
import { InternalFlowiseError } from '../../../errors/internalFlowiseError'
import { getErrorMessage } from '../../../errors/utils'

export class AnthropicProvider implements IChatProvider {
    readonly id = 'anthropic' as const
    readonly name = 'Anthropic'
    readonly type = 'cloud' as const
    readonly credentialName = 'anthropicApi' as const
    readonly defaultModels = ['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229']

    async getModels(_config: { url?: string; credentialId?: string }): Promise<string[]> {
        return this.defaultModels
    }

    async invoke(
        messages: Array<{ role: string; content: string }>,
        config: { model: string; url?: string; credentialId?: string }
    ): Promise<string> {
        if (!config.credentialId) {
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Anthropic credential required but not selected')
        }

        try {
            const anthropicApiKey = await getCredentialApiKey(config.credentialId, 'anthropicApiKey', 'Anthropic')
            const model = new ChatAnthropic({
                anthropicApiKey,
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
            throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, `Anthropic invocation failed: ${getErrorMessage(error)}`)
        }
    }
}
