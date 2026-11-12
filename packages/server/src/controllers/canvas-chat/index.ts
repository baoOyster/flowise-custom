import { Request, Response, NextFunction } from 'express'
import canvasChatService from '../../services/canvas-chat'

const getProviders = async (_req: Request, res: Response, next: NextFunction) => {
    try {
        const apiResponse = canvasChatService.listProviders()
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const getProviderModels = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const provider = typeof req.query.provider === 'string' ? req.query.provider : 'ollama'
        const url = typeof req.query.url === 'string' ? req.query.url : undefined
        const credentialId = typeof req.query.credentialId === 'string' ? req.query.credentialId : undefined

        const apiResponse = await canvasChatService.getProviderModels(provider, { url, credentialId })
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const chat = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const apiResponse = await canvasChatService.chatWithProvider(req.body)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

export default {
    getProviders,
    getProviderModels,
    chat
}
