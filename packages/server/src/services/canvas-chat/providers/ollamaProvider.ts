import axios from 'axios'
import { StatusCodes } from 'http-status-codes'
import { IChatProvider } from './types'
import { InternalFlowiseError } from '../../../errors/internalFlowiseError'
import { getErrorMessage } from '../../../errors/utils'

export class OllamaProvider implements IChatProvider {
    readonly id = 'ollama' as const
    readonly name = 'Ollama'
    readonly type = 'local' as const
    readonly defaultModels = ['llama3', 'mistral', 'qwen2.5-coder', 'deepseek-coder']

    private getBaseUrl(url?: string): string {
        return (url || process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/+$/, '')
    }

    async getModels(config: { url?: string; credentialId?: string }): Promise<string[]> {
        const url = this.getBaseUrl(config.url)
        try {
            const response = await axios.get<{ models?: Array<{ name: string }> }>(`${url}/api/tags`, {
                timeout: 5000
            })
            const models = response.data?.models || []
            const names = models.map((m) => m.name).filter(Boolean)
            return names.length > 0 ? names : this.defaultModels
        } catch (error) {
            console.log(`Error fetching models from Ollama at ${url}: ${getErrorMessage(error)}`)
            return this.defaultModels
        }
    }

    async invoke(
        messages: Array<{ role: string; content: string }>,
        config: { model: string; url?: string; credentialId?: string }
    ): Promise<string> {
        const url = this.getBaseUrl(config.url)
        try {
            const response = await axios.post<{ message?: { content: string } }>(
                `${url}/api/chat`,
                {
                    model: config.model || this.defaultModels[0],
                    messages,
                    stream: false
                },
                { timeout: 210000 }
            )
            return response.data?.message?.content || ''
        } catch (error) {
            throw new InternalFlowiseError(StatusCodes.SERVICE_UNAVAILABLE, `Cannot connect to Ollama at ${url}: ${getErrorMessage(error)}`)
        }
    }
}
