import axios from 'axios'
import { StatusCodes } from 'http-status-codes'
import { IChatProvider } from './types'
import { getCredentialApiKey } from './utils'
import { InternalFlowiseError } from '../../../errors/internalFlowiseError'
import { getErrorMessage } from '../../../errors/utils'

export class GroqProvider implements IChatProvider {
    readonly id = 'groq' as const
    readonly name = 'Groq'
    readonly type = 'cloud' as const
    readonly credentialName = 'groqApi' as const
    readonly defaultModels = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768', 'deepseek-r1-distill-llama-70b']
    readonly url = 'https://api.groq.com/openai/v1'

    async getModels(_config: { url?: string; credentialId?: string }): Promise<string[]> {
        const config = _config
        if (!config.credentialId) {
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Groq credential required but not selected')
        }

        const url = `${this.url}/models`

        try {
            const groqApiKey = await getCredentialApiKey(config.credentialId, 'groqApiKey', 'Groq')
            const response = await axios.get<{ data?: Array<{ id: string }> }>(url, {
                timeout: 5000,
                headers: { Authorization: `Bearer ${groqApiKey}` }
            })
            const models = response.data?.data || []
            const names = models.map((m) => m.id).filter(Boolean)
            return names.length > 0 ? names : this.defaultModels
        } catch (error) {
            console.log(`Error fetching models from Groq: ${getErrorMessage(error)}`)
            return this.defaultModels
        }
    }

    async invoke(
        messages: Array<{ role: string; content: string }>,
        config: { model: string; url?: string; credentialId?: string }
    ): Promise<string> {
        if (!config.credentialId) {
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Groq credential required but not selected')
        }

        const url = `${this.url}/chat/completions`

        try {
            const groqApiKey = await getCredentialApiKey(config.credentialId, 'groqApiKey', 'Groq')
            const response = await axios.post<{ choices?: Array<{ message: { content: string } }> }>(
                url,
                {
                    model: config.model || this.defaultModels[0],
                    messages,
                    stream: false
                },
                { timeout: 210000, headers: { Authorization: `Bearer ${groqApiKey}` } }
            )
            return response.data?.choices?.[0]?.message?.content || ''
        } catch (error) {
            throw new InternalFlowiseError(StatusCodes.SERVICE_UNAVAILABLE, `Groq invocation failed: ${getErrorMessage(error)}`)
        }
    }
}
