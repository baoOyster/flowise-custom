import express from 'express'
import canvasChatController from '../../controllers/canvas-chat'

const router = express.Router()

// Provider-generic routes
router.get('/providers', canvasChatController.getProviders)
router.get('/models', canvasChatController.getProviderModels)
router.post('/chat', canvasChatController.chat)

export default router
