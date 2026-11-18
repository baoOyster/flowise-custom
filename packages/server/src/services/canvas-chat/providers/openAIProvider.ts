import axios from 'axios'
import { StatusCodes } from 'http-status-codes'
import { IChatProvider } from './types'
import { getCredentialApiKey } from './utils'
import { InternalFlowiseError } from '../../../errors/internalFlowiseError'
import { getErrorMessage } from '../../../errors/utils'

export class OpenAIProvider implements IChatProvider {
    readonly id = 'openai' as const
    readonly name = 'OpenAI'
    readonly type = 'cloud' as const
    readonly credentialName = 'openAIApi' as const
    readonly defaultModels = ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o1-mini', 'o3-mini']
    readonly url = 'https://api.openai.com/v1'

    async getModels(_config: { url?: string; credentialId?: string }): Promise<string[]> {
        const config = _config
        if (!config.credentialId) {
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'OpenAI credential required but not selected')
        }

        const url = `${this.url}/models`

        try {
            const openAIApiKey = await getCredentialApiKey(config.credentialId, 'openAIApiKey', 'OpenAI')
            const response = await axios.get<{ data?: Array<{ id: string }> }>(url, {
                timeout: 5000,
                headers: { Authorization: `Bearer ${openAIApiKey}` }
            })
            const models = response.data?.data || []
            const names = models.map((m) => m.id).filter(Boolean)
            return names.length > 0 ? names : this.defaultModels
        } catch (error) {
            console.log(`Error fetching models from OpenAI: ${getErrorMessage(error)}`)
            return this.defaultModels
        }
    }

    async invoke(
        messages: Array<{ role: string; content: string }>,
        config: { model: string; url?: string; credentialId?: string }
    ): Promise<string> {
        if (!config.credentialId) {
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'OpenAI credential required but not selected')
        }

        const url = `${this.url}/chat/completions`

        try {
            const openAIApiKey = await getCredentialApiKey(config.credentialId, 'openAIApiKey', 'OpenAI')
            const response = await axios.post<{ choices?: Array<{ message: { content: string } }> }>(
                url,
                {
                    model: config.model || this.defaultModels[0],
                    messages,
                    stream: false
                },
                { timeout: 210000, headers: { Authorization: `Bearer ${openAIApiKey}` } }
            )
            return response.data?.choices?.[0]?.message?.content || ''
        } catch (error) {
            throw new InternalFlowiseError(StatusCodes.SERVICE_UNAVAILABLE, `OpenAI invocation failed: ${getErrorMessage(error)}`)
        }
    }
}
