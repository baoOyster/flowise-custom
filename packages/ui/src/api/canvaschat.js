import client from './client'

const getProviders = () => client.get('/canvas-chat/providers')

const getModels = (provider, params) => client.get('/canvas-chat/models', { params: { provider, ...params } })

const chat = (body) => client.post('/canvas-chat/chat', body)

export default {
    getProviders,
    getModels,
    chat
}
