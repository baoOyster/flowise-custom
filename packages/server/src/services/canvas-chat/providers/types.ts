export type ChatProviderId = 'ollama' | 'openai' | 'anthropic' | 'groq'
export type ChatProviderType = 'local' | 'cloud'
export type ChatCredentialName = 'openAIApi' | 'anthropicApi' | 'groqApi'

export interface IChatProvider {
    id: ChatProviderId
    name: string
    type: ChatProviderType
    credentialName?: ChatCredentialName
    defaultModels: string[]
    getModels(config: { url?: string; credentialId?: string }): Promise<string[]>
    invoke(
        messages: Array<{ role: string; content: string }>,
        config: { model: string; url?: string; credentialId?: string }
    ): Promise<string>
}

export interface IChatProviderMetadata {
    id: ChatProviderId
    name: string
    type: ChatProviderType
    credentialName?: ChatCredentialName
    defaultModels: string[]
}
