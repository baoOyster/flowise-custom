import { StatusCodes } from 'http-status-codes'
import { IChatProvider, IChatProviderMetadata, ChatProviderId } from './types'
import { OllamaProvider } from './ollamaProvider'
import { OpenAIProvider } from './openAIProvider'
import { AnthropicProvider } from './anthropicProvider'
import { GroqProvider } from './groqProvider'
import { InternalFlowiseError } from '../../../errors/internalFlowiseError'

const providerInstances: Record<ChatProviderId, IChatProvider> = {
    ollama: new OllamaProvider(),
    openai: new OpenAIProvider(),
    anthropic: new AnthropicProvider(),
    groq: new GroqProvider()
}

export const getProvider = (id: string): IChatProvider => {
    const normalizedId = (id || '').trim().toLowerCase() as ChatProviderId
    const provider = providerInstances[normalizedId]
    if (!provider) {
        throw new InternalFlowiseError(
            StatusCodes.BAD_REQUEST,
            `Unsupported canvas chat provider: "${id}". Supported providers: ${Object.keys(providerInstances).join(', ')}`
        )
    }
    return provider
}

export const listProviders = (): IChatProviderMetadata[] => {
    return Object.values(providerInstances).map((provider) => ({
        id: provider.id,
        name: provider.name,
        type: provider.type,
        credentialName: provider.credentialName,
        defaultModels: [...provider.defaultModels]
    }))
}
