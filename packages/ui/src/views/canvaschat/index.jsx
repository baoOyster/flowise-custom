import { useState, useEffect, useRef, Component } from 'react'
import PropTypes from 'prop-types'
import { useNavigate, useLocation } from 'react-router-dom'
import { useSelector, useDispatch } from 'react-redux'
import canvasChatApi from '@/api/canvaschat'
import credentialsApi from '@/api/credentials'
// material-ui
import {
    Box,
    Button,
    Card,
    CardContent,
    Chip,
    CircularProgress,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    IconButton,
    MenuItem,
    OutlinedInput,
    Select,
    Stack,
    TextField,
    Tooltip,
    Typography,
    Avatar
} from '@mui/material'

// icons
import {
    IconChevronLeft,
    IconSend,
    IconSettings,
    IconRefresh,
    IconCheck,
    IconAlertCircle,
    IconSparkles,
    IconCode,
    IconArrowRight,
    IconTrash,
    IconCopy
} from '@tabler/icons-react'

// project imports
import { MemoizedReactMarkdown } from '@/ui-component/markdown/MemoizedReactMarkdown'
import nodesApi from '@/api/nodes'
import { SET_COMPONENT_NODES, enqueueSnackbar as enqueueSnackbarAction } from '@/store/actions'
import { extractFlowFromResponse, hydrateFlowData } from './flowHydrator'

const DEFAULT_SYSTEM_PROMPT = `You are an expert Flowise AI Workflow generator.
When asked to create or modify a workflow/chatflow, produce a valid Flowise flow JSON inside a \`\`\`json\`\`\` markdown code block.

Canonical Workflow Architecture Patterns:

Pattern 1: Conversational Chatbot
\`\`\`json
{
  "nodes": [
    { "id": "chatModel_0", "name": "chatOllama", "inputs": { "modelName": "llama3", "temperature": 0.7 } },
    { "id": "memory_0", "name": "bufferMemory" },
    { "id": "chain_0", "name": "conversationChain" }
  ],
  "edges": [
    { "source": "chatModel_0", "target": "chain_0", "targetInput": "model" },
    { "source": "memory_0", "target": "chain_0", "targetInput": "memory" }
  ]
}
\`\`\`

Pattern 2: Document Q&A / RAG with Vector Store
\`\`\`json
{
  "nodes": [
    { "id": "splitter_0", "name": "recursiveCharacterTextSplitter", "inputs": { "chunkSize": 500, "chunkOverlap": 50 } },
    { "id": "docLoader_0", "name": "pdfFile" },
    { "id": "embeddings_0", "name": "ollamaEmbedding", "inputs": { "modelName": "nomic-embed-text" } },
    { "id": "vectorStore_0", "name": "qdrant", "inputs": { "qdrantServerUrl": "http://localhost:6333", "qdrantCollection": "my_collection" } },
    { "id": "chatModel_0", "name": "chatOllama", "inputs": { "modelName": "llama3", "temperature": 0.7 } },
    { "id": "memory_0", "name": "bufferMemory" },
    { "id": "chain_0", "name": "conversationalRetrievalQAChain" }
  ],
  "edges": [
    { "source": "splitter_0", "target": "docLoader_0", "targetInput": "textSplitter" },
    { "source": "docLoader_0", "target": "vectorStore_0", "targetInput": "document" },
    { "source": "embeddings_0", "target": "vectorStore_0", "targetInput": "embeddings" },
    { "source": "vectorStore_0", "target": "chain_0", "targetInput": "vectorStoreRetriever" },
    { "source": "chatModel_0", "target": "chain_0", "targetInput": "model" },
    { "source": "memory_0", "target": "chain_0", "targetInput": "memory" }
  ]
}
\`\`\`

Rules:
1. For Document Q&A / RAG: ALWAYS use "conversationalRetrievalQAChain" (NEVER "conversationChain").
2. Connect edges in correct direction:
   - textSplitter -> documentLoader (targetInput: "textSplitter")
   - documentLoader -> vectorStore (targetInput: "document")
   - embeddings -> vectorStore (targetInput: "embeddings")
   - vectorStore -> conversationalRetrievalQAChain (targetInput: "vectorStoreRetriever")
   - chatModel -> chain (targetInput: "model")
   - memory -> chain (targetInput: "memory")
3. Provide unique IDs (e.g. chatModel_0, vectorStore_0).
4. Always wrap the complete JSON in a \`\`\`json code block, accompanied by a brief helpful explanation.`
const STARTER_PROMPTS = [
    {
        title: 'Conversational Bot',
        desc: 'ChatOllama + Buffer Memory + Conversation Chain',
        prompt: 'Create a conversational chatbot workflow using ChatOllama, Buffer Memory, and a Conversation Chain.'
    },
    {
        title: 'Local RAG Chain',
        desc: 'PDF Loader + Ollama Embeddings + In-Memory Vector Store + Retrieval QA',
        prompt: 'Create a local document Q&A workflow with PDF loader, Ollama Embeddings, InMemoryVectorStore, and Conversational Retrieval QA Chain with ChatOllama.'
    },
    {
        title: 'LLM Chain with Prompt',
        desc: 'ChatOllama + Prompt Template + LLM Chain',
        prompt: 'Create a simple LLM Chain with a custom Prompt Template and ChatOllama.'
    }
]

const DEFAULT_PROVIDERS = [
    {
        id: 'ollama',
        name: 'Ollama',
        type: 'local',
        defaultModels: ['llama3', 'mistral', 'qwen2.5-coder', 'deepseek-coder']
    },
    {
        id: 'openai',
        name: 'OpenAI',
        type: 'cloud',
        credentialName: 'openAIApi',
        defaultModels: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o1-mini', 'o3-mini']
    },
    {
        id: 'anthropic',
        name: 'Anthropic',
        type: 'cloud',
        credentialName: 'anthropicApi',
        defaultModels: ['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229']
    },
    {
        id: 'groq',
        name: 'Groq',
        type: 'cloud',
        credentialName: 'groqApi',
        defaultModels: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768', 'deepseek-r1-distill-llama-70b']
    }
]

const CanvasChat = () => {
    const navigate = useNavigate()
    const dispatch = useDispatch()
    const location = useLocation()
    const canvas = useSelector((state) => state.canvas)
    const customization = useSelector((state) => state.customization)
    const isDarkMode = Boolean(customization?.isDarkMode)

    // Palette tokens tailored for contrast in both light and dark modes
    const colors = {
        pageBg: isDarkMode ? '#131518' : '#f8f9fa',
        headerBg: isDarkMode ? '#1d2025' : '#ffffff',
        border: isDarkMode ? '#2f3542' : '#e2e8f0',

        // Cards & surfaces
        cardBg: isDarkMode ? '#22262d' : '#ffffff',
        cardBorder: isDarkMode ? '#373e4d' : '#e2e8f0',
        cardHoverBorder: isDarkMode ? '#7c4dff' : '#2196f3',
        cardHoverBg: isDarkMode ? '#2a2f38' : '#f1f5f9',

        // Message bubbles
        assistantBg: isDarkMode ? '#22262d' : '#ffffff',
        assistantBorder: isDarkMode ? '#373e4d' : '#e2e8f0',
        assistantText: isDarkMode ? '#f1f5f9' : '#1e293b',

        userBg: isDarkMode ? '#342557' : '#ede7f6',
        userBorder: isDarkMode ? '#7c4dff' : '#d1c4e9',
        userText: isDarkMode ? '#ffffff' : '#1e293b',

        // Workflow card inside message
        flowCardBg: isDarkMode ? '#1a1d24' : '#fafafa',
        flowCardBorder: isDarkMode ? '#7c4dff' : '#673ab7',
        chipBg: isDarkMode ? '#2d3340' : '#f1f5f9',
        chipBorder: isDarkMode ? '#475166' : '#cbd5e1',
        chipText: isDarkMode ? '#e2e8f0' : '#1e293b',

        // Bottom input
        inputBarBg: isDarkMode ? '#1d2025' : '#ffffff',
        inputFieldBg: isDarkMode ? '#131518' : '#f8f9fa',
        inputBorder: isDarkMode ? '#373e4d' : '#cbd5e1',
        inputText: isDarkMode ? '#f8fafc' : '#0f172a',
        placeholder: isDarkMode ? '#8c9ab3' : '#94a3b8',

        // Buttons & icons
        headerBtnBg: isDarkMode ? '#2a2f38' : '#f1f5f9',
        headerBtnBorder: isDarkMode ? '#40495a' : '#e2e8f0',
        headerBtnColor: isDarkMode ? '#e2e8f0' : '#475569',
        headerBtnHover: isDarkMode ? '#373e4d' : '#e2e8f0',

        sendBtnBg: isDarkMode ? '#7c4dff' : '#2196f3',
        sendBtnDisabledBg: isDarkMode ? '#282d37' : '#e2e8f0',
        sendBtnColor: '#ffffff',
        sendBtnDisabledColor: isDarkMode ? '#5a657c' : '#94a3b8',

        trashBtnBg: isDarkMode ? '#2a2f38' : '#f1f5f9',
        trashBtnBorder: isDarkMode ? '#40495a' : '#e2e8f0',
        trashBtnColor: isDarkMode ? '#f87171' : '#dc2626',
        trashBtnDisabledColor: isDarkMode ? '#5a657c' : '#cbd5e1',

        // Typography
        primaryText: isDarkMode ? '#ffffff' : '#0f172a',
        secondaryText: isDarkMode ? '#9db0cb' : '#64748b'
    }

    const isAgentCanvas = location.state?.isAgentCanvas || false
    const existingChatflow = location.state?.chatflow || null

    // Multi-provider state
    const [providers, setProviders] = useState(DEFAULT_PROVIDERS)
    const [selectedProvider, setSelectedProvider] = useState(() => localStorage.getItem('canvaschat_provider') || 'ollama')
    const [selectedCredentialId, setSelectedCredentialId] = useState(
        () => localStorage.getItem(`canvaschat_${localStorage.getItem('canvaschat_provider') || 'ollama'}_credential`) || ''
    )
    const [availableCredentials, setAvailableCredentials] = useState([])
    const [ollamaUrl, setOllamaUrl] = useState(() => localStorage.getItem('ollama_url') || 'http://localhost:11434')
    const [selectedModel, setSelectedModel] = useState(
        () =>
            localStorage.getItem(`canvaschat_${localStorage.getItem('canvaschat_provider') || 'ollama'}_model`) ||
            localStorage.getItem('ollama_model') ||
            ''
    )
    const [availableModels, setAvailableModels] = useState([])
    const [isOllamaConnected, setIsOllamaConnected] = useState(false)
    const [isCheckingConnection, setIsCheckingConnection] = useState(false)
    const [connectionError, setConnectionError] = useState('')
    const [systemPrompt, setSystemPrompt] = useState(DEFAULT_SYSTEM_PROMPT)
    const [isSettingsOpen, setIsSettingsOpen] = useState(false)

    const currentProvider =
        providers.find((p) => p.id === selectedProvider) || DEFAULT_PROVIDERS.find((p) => p.id === selectedProvider) || DEFAULT_PROVIDERS[0]

    const isProviderReady = currentProvider.type === 'local' ? isOllamaConnected : Boolean(selectedCredentialId)

    // Chat state
    const [messages, setMessages] = useState([
        {
            role: 'assistant',
            content:
                'Hello! I can help you design and generate Flowise workflows using your chosen AI model. Describe the workflow you need or pick one of the starter templates below!'
        }
    ])
    const [inputPrompt, setInputPrompt] = useState('')
    const [isLoading, setIsLoading] = useState(false)
    const [activeFlowData, setActiveFlowData] = useState(null)
    const [previewJsonOpen, setPreviewJsonOpen] = useState(false)

    const messagesEndRef = useRef(null)

    const enqueueSnackbar = (...args) => dispatch(enqueueSnackbarAction(...args))

    // Ensure component nodes are loaded for hydration
    useEffect(() => {
        if (!canvas.componentNodes || canvas.componentNodes.length === 0) {
            nodesApi
                .getAllNodes()
                .then((res) => {
                    if (res?.data && Array.isArray(res.data)) {
                        dispatch({ type: SET_COMPONENT_NODES, componentNodes: res.data })
                    }
                })
                .catch((err) => {
                    console.error('Failed to load component nodes:', err)
                })
        }
    }, [canvas.componentNodes, dispatch])

    // Fetch dynamic provider list from backend
    useEffect(() => {
        canvasChatApi
            .getProviders()
            .then((res) => {
                if (Array.isArray(res?.data) && res.data.length > 0) {
                    setProviders(res.data)
                }
            })
            .catch((err) => {
                console.warn('Failed to load providers list from backend, using defaults:', err)
            })
    }, [])

    const fetchCredentialsForProvider = async (prov) => {
        if (!prov?.credentialName) {
            setAvailableCredentials([])
            return []
        }
        try {
            const res = await credentialsApi.getCredentialsByName(prov.credentialName)
            const creds = Array.isArray(res?.data) ? res.data : []
            setAvailableCredentials(creds)
            return creds
        } catch (err) {
            console.warn('Failed to fetch credentials for provider:', err)
            setAvailableCredentials([])
            return []
        }
    }

    // Test and fetch Ollama models via backend server-to-server proxy
    const checkOllamaConnection = async (targetUrl = ollamaUrl) => {
        setIsCheckingConnection(true)
        setConnectionError('')
        try {
            const trimmedUrl = targetUrl.replace(/\/+$/, '')
            const res = await canvasChatApi.getModels('ollama', { url: trimmedUrl })
            const modelNames = Array.isArray(res?.data) ? res.data : []

            setAvailableModels(modelNames)
            setIsOllamaConnected(true)

            if (modelNames.length > 0) {
                const savedModel = localStorage.getItem('canvaschat_ollama_model')
                const modelToUse = savedModel && modelNames.includes(savedModel) ? savedModel : modelNames[0]
                setSelectedModel(modelToUse)
                localStorage.setItem('canvaschat_ollama_model', modelToUse)
            }
            localStorage.setItem('ollama_url', trimmedUrl)
        } catch (err) {
            setIsOllamaConnected(false)
            setAvailableModels([])
            setConnectionError(
                err.response?.data?.message || err.message || `Cannot connect to Ollama at ${targetUrl}. Ensure Ollama is running.`
            )
        } finally {
            setIsCheckingConnection(false)
        }
    }

    const fetchModelsForProvider = async (providerId, config = {}) => {
        const prov = providers.find((p) => p.id === providerId) || DEFAULT_PROVIDERS.find((p) => p.id === providerId)
        const provDefaults = prov?.defaultModels || []

        if (providerId === 'ollama') {
            return checkOllamaConnection(config.url || ollamaUrl)
        }

        try {
            const res = await canvasChatApi.getModels(providerId, config)
            const models = Array.isArray(res?.data) && res.data.length > 0 ? res.data : provDefaults
            setAvailableModels(models)
            const savedModel = localStorage.getItem(`canvaschat_${providerId}_model`)
            const modelToSet = savedModel && models.includes(savedModel) ? savedModel : models[0] || ''
            setSelectedModel(modelToSet)
            if (modelToSet) {
                localStorage.setItem(`canvaschat_${providerId}_model`, modelToSet)
            }
        } catch (e) {
            console.warn(`Failed to fetch models for ${providerId}:`, e)
            setAvailableModels(provDefaults)
            const savedModel = localStorage.getItem(`canvaschat_${providerId}_model`)
            const modelToSet = savedModel && provDefaults.includes(savedModel) ? savedModel : provDefaults[0] || ''
            setSelectedModel(modelToSet)
        }
    }

    const handleProviderChange = async (newProviderId) => {
        setSelectedProvider(newProviderId)
        localStorage.setItem('canvaschat_provider', newProviderId)

        const targetProv = providers.find((p) => p.id === newProviderId) || DEFAULT_PROVIDERS.find((p) => p.id === newProviderId)
        const savedCredId = localStorage.getItem(`canvaschat_${newProviderId}_credential`) || ''
        setSelectedCredentialId(savedCredId)

        if (targetProv?.type === 'cloud') {
            const creds = await fetchCredentialsForProvider(targetProv)
            let effectiveCredId = savedCredId
            if (!effectiveCredId && creds.length > 0) {
                effectiveCredId = creds[0].id
                setSelectedCredentialId(effectiveCredId)
                localStorage.setItem(`canvaschat_${newProviderId}_credential`, effectiveCredId)
            }
            await fetchModelsForProvider(newProviderId, { credentialId: effectiveCredId })
        } else {
            setAvailableCredentials([])
            await fetchModelsForProvider('ollama', { url: ollamaUrl })
        }
    }

    useEffect(() => {
        const prov = providers.find((p) => p.id === selectedProvider) || DEFAULT_PROVIDERS.find((p) => p.id === selectedProvider)
        if (prov?.type === 'cloud') {
            fetchCredentialsForProvider(prov).then((creds) => {
                let effectiveCredId = selectedCredentialId
                if (!effectiveCredId && creds.length > 0) {
                    effectiveCredId = creds[0].id
                    setSelectedCredentialId(effectiveCredId)
                    localStorage.setItem(`canvaschat_${selectedProvider}_credential`, effectiveCredId)
                }
                fetchModelsForProvider(selectedProvider, { credentialId: effectiveCredId })
            })
        } else {
            checkOllamaConnection(ollamaUrl)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedProvider])

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }, [messages, isLoading])

    const handleSendMessage = async (textToSend) => {
        const text = textToSend || inputPrompt
        if (!text.trim() || isLoading) return

        if (currentProvider.type === 'local' && !isOllamaConnected) {
            enqueueSnackbar({
                message: 'Ollama is not connected. Please check your Ollama configuration in Settings.',
                options: { variant: 'warning' }
            })
            setIsSettingsOpen(true)
            return
        }

        if (currentProvider.type === 'cloud' && !selectedCredentialId) {
            enqueueSnackbar({
                message: `Please select a saved credential for ${currentProvider.name} in Settings.`,
                options: { variant: 'warning' }
            })
            setIsSettingsOpen(true)
            return
        }

        const modelToUse = selectedModel || availableModels[0] || currentProvider.defaultModels[0]
        if (!modelToUse) {
            enqueueSnackbar({
                message: `No model selected for ${currentProvider.name}. Please select a model.`,
                options: { variant: 'warning' }
            })
            setIsSettingsOpen(true)
            return
        }

        const newMessages = [...messages, { role: 'user', content: text }]
        setMessages(newMessages)
        setInputPrompt('')
        setIsLoading(true)

        try {
            const chatPayload = {
                provider: selectedProvider,
                model: modelToUse,
                credentialId: selectedCredentialId || undefined,
                url: currentProvider.type === 'local' ? ollamaUrl : undefined,
                prompt: text,
                messages: newMessages.map((m) => ({
                    role: m.role,
                    content: m.content
                })),
                systemPrompt
            }
            const response = await canvasChatApi.chat(chatPayload)
            const assistantReply = response?.data?.message || 'No response received from provider.'
            let extractedFlow = response?.data?.flowData

            if (!extractedFlow) {
                extractedFlow = extractFlowFromResponse(assistantReply)
            }
            if (extractedFlow) {
                setActiveFlowData(extractedFlow)
            }

            setMessages((prev) => [
                ...prev,
                {
                    role: 'assistant',
                    content: assistantReply,
                    flowData: extractedFlow
                }
            ])
        } catch (err) {
            const errorMsg = err.response?.data?.message || err.message || 'Error generating workflow'
            enqueueSnackbar({
                message: errorMsg,
                options: { variant: 'error' }
            })
            setMessages((prev) => [
                ...prev,
                {
                    role: 'assistant',
                    content: `Error: ${errorMsg}`
                }
            ])
        } finally {
            setIsLoading(false)
        }
    }

    const handleLoadIntoCanvas = (flowToLoad = activeFlowData) => {
        if (!flowToLoad) {
            enqueueSnackbar({
                message: 'No valid workflow detected to load.',
                options: { variant: 'warning' }
            })
            return
        }

        try {
            const nodesCatalog = canvas.componentNodes || []
            const hydrated = hydrateFlowData(flowToLoad, nodesCatalog)

            if (!hydrated.nodes || hydrated.nodes.length === 0) {
                enqueueSnackbar({
                    message: 'Flow data contains no valid nodes.',
                    options: { variant: 'error' }
                })
                return
            }

            const templateFlowData = JSON.stringify(hydrated)
            const targetCanvasPath = isAgentCanvas ? '/agentcanvas' : '/canvas'

            enqueueSnackbar({
                message: `Loading ${hydrated.nodes.length} nodes into Canvas...`,
                options: { variant: 'success' }
            })

            navigate(targetCanvasPath, {
                state: {
                    templateFlowData,
                    chatflow: existingChatflow
                }
            })
        } catch (e) {
            console.error('Failed to load flow into canvas:', e)
            enqueueSnackbar({
                message: `Failed to prepare flow for canvas: ${e.message}`,
                options: { variant: 'error' }
            })
        }
    }

    return (
        <Box
            sx={{
                height: '100vh',
                maxHeight: '100vh',
                width: '100%',
                maxWidth: '100%',
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column',
                bgcolor: colors.pageBg
            }}
        >
            {/* Top Toolbar */}
            <Box
                sx={{
                    flexShrink: 0,
                    px: 3,
                    py: 1.5,
                    borderBottom: `1px solid ${colors.border}`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    bgcolor: colors.headerBg
                }}
            >
                <Stack direction='row' alignItems='center' spacing={2}>
                    <Tooltip title='Back to Canvas'>
                        <IconButton
                            onClick={() =>
                                window.history.state && window.history.state.idx > 0
                                    ? navigate(-1)
                                    : navigate(isAgentCanvas ? '/agentcanvas' : '/canvas')
                            }
                            sx={{
                                bgcolor: colors.headerBtnBg,
                                color: colors.headerBtnColor,
                                border: `1px solid ${colors.headerBtnBorder}`,
                                borderRadius: '50%',
                                p: 1,
                                '&:hover': {
                                    bgcolor: colors.headerBtnHover,
                                    color: colors.primaryText
                                }
                            }}
                        >
                            <IconChevronLeft size={20} />
                        </IconButton>
                    </Tooltip>

                    <Box>
                        <Stack direction='row' alignItems='center' spacing={1.5}>
                            <Typography variant='h4' sx={{ fontWeight: 700, color: colors.primaryText }}>
                                Canvas AI Assistant
                            </Typography>
                            <Select
                                size='small'
                                value={selectedProvider}
                                onChange={(e) => handleProviderChange(e.target.value)}
                                sx={{
                                    height: 32,
                                    borderRadius: 1.5,
                                    fontSize: '0.8rem',
                                    fontWeight: 700,
                                    bgcolor: colors.headerBtnBg,
                                    color: colors.primaryText,
                                    '& .MuiOutlinedInput-notchedOutline': {
                                        borderColor: colors.headerBtnBorder
                                    },
                                    '& .MuiSelect-select': {
                                        py: 0.5,
                                        px: 1.5,
                                        display: 'flex',
                                        alignItems: 'center'
                                    }
                                }}
                            >
                                {providers.map((p) => (
                                    <MenuItem key={p.id} value={p.id} sx={{ fontSize: '0.82rem', fontWeight: 600 }}>
                                        {p.name}
                                    </MenuItem>
                                ))}
                            </Select>
                            <Chip
                                size='small'
                                icon={
                                    (currentProvider.type === 'local' ? isOllamaConnected : Boolean(selectedCredentialId)) ? (
                                        <IconCheck size={14} color={isDarkMode ? '#4ade80' : '#16a34a'} />
                                    ) : (
                                        <IconAlertCircle size={14} color={isDarkMode ? '#fb923c' : '#ea580c'} />
                                    )
                                }
                                label={
                                    currentProvider.type === 'local'
                                        ? isOllamaConnected
                                            ? `${selectedModel || 'Connected'}`
                                            : 'Ollama Offline'
                                        : selectedCredentialId
                                        ? `${selectedModel || 'Ready'}`
                                        : 'No Credential'
                                }
                                sx={{
                                    fontWeight: 600,
                                    fontSize: '0.78rem',
                                    bgcolor: (currentProvider.type === 'local' ? isOllamaConnected : Boolean(selectedCredentialId))
                                        ? isDarkMode
                                            ? 'rgba(34, 197, 94, 0.16)'
                                            : '#ecfdf5'
                                        : isDarkMode
                                        ? 'rgba(249, 115, 22, 0.16)'
                                        : '#fff7ed',
                                    color: (currentProvider.type === 'local' ? isOllamaConnected : Boolean(selectedCredentialId))
                                        ? isDarkMode
                                            ? '#4ade80'
                                            : '#15803d'
                                        : isDarkMode
                                        ? '#fb923c'
                                        : '#c2410c',
                                    border: `1px solid ${
                                        (currentProvider.type === 'local' ? isOllamaConnected : Boolean(selectedCredentialId))
                                            ? isDarkMode
                                                ? 'rgba(34, 197, 94, 0.4)'
                                                : '#86efac'
                                            : isDarkMode
                                            ? 'rgba(249, 115, 22, 0.4)'
                                            : '#fdba74'
                                    }`
                                }}
                            />
                        </Stack>
                        <Typography variant='caption' sx={{ color: colors.secondaryText, mt: 0.25, display: 'block' }}>
                            Generate and wire Flowise chatflows with AI (Ollama, OpenAI, Anthropic, Groq)
                        </Typography>
                    </Box>
                </Stack>

                <Stack direction='row' alignItems='center' spacing={1.5}>
                    {activeFlowData && (
                        <Button
                            variant='contained'
                            startIcon={<IconArrowRight size={18} />}
                            onClick={() => handleLoadIntoCanvas(activeFlowData)}
                            sx={{
                                fontWeight: 700,
                                px: 2.2,
                                py: 0.8,
                                bgcolor: isDarkMode ? '#7c4dff' : '#673ab7',
                                color: '#ffffff',
                                '&:hover': {
                                    bgcolor: isDarkMode ? '#651fff' : '#5e35b1'
                                },
                                boxShadow: isDarkMode ? '0 4px 14px rgba(124, 77, 255, 0.35)' : '0 2px 8px rgba(103, 58, 183, 0.2)'
                            }}
                        >
                            Load Flow into Canvas
                        </Button>
                    )}

                    <Tooltip title='AI Provider & Prompt Settings'>
                        <IconButton
                            onClick={() => setIsSettingsOpen(true)}
                            sx={{
                                bgcolor: colors.headerBtnBg,
                                color: colors.headerBtnColor,
                                border: `1px solid ${colors.headerBtnBorder}`,
                                borderRadius: '50%',
                                p: 1,
                                '&:hover': {
                                    bgcolor: colors.headerBtnHover,
                                    color: colors.primaryText
                                }
                            }}
                        >
                            <IconSettings size={20} />
                        </IconButton>
                    </Tooltip>
                </Stack>
            </Box>

            {/* Provider Configuration Warning Banner */}
            {((currentProvider.type === 'local' && !isOllamaConnected) || (currentProvider.type === 'cloud' && !selectedCredentialId)) && (
                <Box
                    sx={{
                        flexShrink: 0,
                        px: 3,
                        py: 1.2,
                        bgcolor: isDarkMode ? '#2d1808' : '#fffbeb',
                        color: isDarkMode ? '#fdba74' : '#b45309',
                        borderBottom: `1px solid ${isDarkMode ? '#7c2d12' : '#fde68a'}`,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between'
                    }}
                >
                    <Stack direction='row' alignItems='center' spacing={1}>
                        <IconAlertCircle size={18} color={isDarkMode ? '#fb923c' : '#d97706'} />
                        <Typography variant='body2' sx={{ fontWeight: 600 }}>
                            {currentProvider.type === 'local'
                                ? connectionError || 'Cannot connect to Ollama. Make sure Ollama is running and CORS is enabled.'
                                : `No saved credential selected for ${currentProvider.name}. Please select or create an API credential.`}
                        </Typography>
                    </Stack>
                    <Button
                        size='small'
                        variant='outlined'
                        onClick={() => setIsSettingsOpen(true)}
                        sx={{
                            color: isDarkMode ? '#fdba74' : '#b45309',
                            borderColor: isDarkMode ? '#9a3412' : '#d97706',
                            fontWeight: 600,
                            '&:hover': {
                                bgcolor: isDarkMode ? 'rgba(251, 146, 60, 0.1)' : 'rgba(217, 119, 6, 0.1)'
                            }
                        }}
                    >
                        Configure {currentProvider.name}
                    </Button>
                </Box>
            )}

            {/* Main Chat Workspace */}
            <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>
                {/* Chat Messages Scroll Area */}
                <Box
                    sx={{
                        flex: 1,
                        minHeight: 0,
                        overflowY: 'auto',
                        overflowX: 'hidden',
                        p: 3,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 2.5,
                        // Prominent Custom Scrollbar
                        scrollbarWidth: 'thin',
                        scrollbarColor: isDarkMode ? '#6b7280 rgba(255, 255, 255, 0.06)' : '#94a3b8 rgba(0, 0, 0, 0.06)',
                        '&::-webkit-scrollbar': {
                            width: '10px',
                            display: 'block'
                        },
                        '&::-webkit-scrollbar-track': {
                            background: isDarkMode ? 'rgba(255, 255, 255, 0.04)' : 'rgba(0, 0, 0, 0.04)',
                            borderRadius: '8px',
                            my: 1
                        },
                        '&::-webkit-scrollbar-thumb': {
                            backgroundColor: isDarkMode ? '#6b7280' : '#94a3b8',
                            borderRadius: '8px',
                            border: `2px solid ${colors.pageBg}`,
                            minHeight: '40px',
                            '&:hover': {
                                backgroundColor: isDarkMode ? '#a78bfa' : '#673ab7'
                            }
                        }
                    }}
                >
                    {/* Starter Prompts */}
                    {messages.length <= 1 && (
                        <Box sx={{ my: 1.5 }}>
                            <Typography variant='subtitle2' sx={{ mb: 1.5, color: colors.secondaryText, fontWeight: 600 }}>
                                Quick Workflow Starters:
                            </Typography>
                            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                                {STARTER_PROMPTS.map((starter, idx) => (
                                    <Card
                                        key={idx}
                                        sx={{
                                            flex: 1,
                                            cursor: 'pointer',
                                            bgcolor: colors.cardBg,
                                            border: `1px solid ${colors.cardBorder}`,
                                            boxShadow: isDarkMode ? '0 4px 12px rgba(0,0,0,0.3)' : '0 2px 8px rgba(0,0,0,0.04)',
                                            borderRadius: 2,
                                            transition: 'all 0.2s ease',
                                            '&:hover': {
                                                borderColor: colors.cardHoverBorder,
                                                bgcolor: colors.cardHoverBg,
                                                transform: 'translateY(-2px)'
                                            }
                                        }}
                                        onClick={() => handleSendMessage(starter.prompt)}
                                    >
                                        <CardContent sx={{ p: 2, '&:last-child': { pb: 2 } }}>
                                            <Stack direction='row' spacing={1} alignItems='center' sx={{ mb: 0.75 }}>
                                                <IconSparkles size={18} color={isDarkMode ? '#a78bfa' : '#673ab7'} />
                                                <Typography variant='subtitle1' sx={{ fontWeight: 700, color: colors.primaryText }}>
                                                    {starter.title}
                                                </Typography>
                                            </Stack>
                                            <Typography
                                                variant='caption'
                                                sx={{ color: colors.secondaryText, display: 'block', lineHeight: 1.4 }}
                                            >
                                                {starter.desc}
                                            </Typography>
                                        </CardContent>
                                    </Card>
                                ))}
                            </Stack>
                        </Box>
                    )}

                    {/* Messages List */}
                    {messages.map((msg, index) => {
                        const isUser = msg.role === 'user'
                        const flow = msg.flowData

                        return (
                            <Box
                                key={index}
                                sx={{
                                    display: 'flex',
                                    flexDirection: isUser ? 'row-reverse' : 'row',
                                    alignItems: 'flex-start',
                                    gap: 1.5,
                                    maxWidth: '90%',
                                    alignSelf: isUser ? 'flex-end' : 'flex-start'
                                }}
                            >
                                <Avatar
                                    sx={{
                                        bgcolor: isUser ? (isDarkMode ? '#7c4dff' : '#673ab7') : isDarkMode ? '#2563eb' : '#2196f3',
                                        color: '#ffffff',
                                        width: 36,
                                        height: 36,
                                        fontWeight: 700,
                                        boxShadow: '0 2px 8px rgba(0,0,0,0.2)'
                                    }}
                                >
                                    {isUser ? 'U' : <IconSparkles size={20} color='#ffffff' />}
                                </Avatar>

                                <Box sx={{ maxWidth: '100%' }}>
                                    <Card
                                        sx={{
                                            p: 2,
                                            bgcolor: isUser ? colors.userBg : colors.assistantBg,
                                            border: `1px solid ${isUser ? colors.userBorder : colors.assistantBorder}`,
                                            borderRadius: 2,
                                            color: isUser ? colors.userText : colors.assistantText,
                                            boxShadow: isDarkMode ? '0 4px 14px rgba(0,0,0,0.25)' : '0 2px 8px rgba(0,0,0,0.04)',
                                            '& .react-markdown': {
                                                color: isUser ? colors.userText : colors.assistantText
                                            },
                                            '& .react-markdown p': {
                                                m: 0,
                                                lineHeight: 1.6
                                            },
                                            '& .react-markdown code': {
                                                bgcolor: isDarkMode ? '#131518' : '#f1f5f9',
                                                color: isDarkMode ? '#f87171' : '#e11d48',
                                                px: 0.6,
                                                py: 0.2,
                                                borderRadius: 1,
                                                fontSize: '0.88em'
                                            }
                                        }}
                                    >
                                        <MemoizedReactMarkdown>{msg.content}</MemoizedReactMarkdown>
                                    </Card>

                                    {/* Action Card if message contains a generated flow */}
                                    {flow && (
                                        <Card
                                            sx={{
                                                mt: 1.5,
                                                p: 2.5,
                                                bgcolor: colors.flowCardBg,
                                                border: `1px solid ${colors.flowCardBorder}`,
                                                borderRadius: 2,
                                                boxShadow: isDarkMode
                                                    ? '0 6px 20px rgba(124, 77, 255, 0.2)'
                                                    : '0 4px 12px rgba(103, 58, 183, 0.08)'
                                            }}
                                        >
                                            <Stack direction='row' justifyContent='space-between' alignItems='center' sx={{ mb: 1.5 }}>
                                                <Stack direction='row' spacing={1} alignItems='center'>
                                                    <IconSparkles size={20} color={isDarkMode ? '#a78bfa' : '#673ab7'} />
                                                    <Typography variant='subtitle1' sx={{ fontWeight: 700, color: colors.primaryText }}>
                                                        Generated Flowise Workflow
                                                    </Typography>
                                                    <Chip
                                                        size='small'
                                                        label={`${flow.nodes?.length || 0} nodes, ${flow.edges?.length || 0} edges`}
                                                        sx={{
                                                            fontWeight: 600,
                                                            bgcolor: isDarkMode ? 'rgba(124, 77, 255, 0.2)' : '#ede7f6',
                                                            color: isDarkMode ? '#c4b5fd' : '#5e35b1',
                                                            border: `1px solid ${isDarkMode ? '#7c4dff' : '#b39ddb'}`
                                                        }}
                                                    />
                                                </Stack>

                                                <Button
                                                    size='small'
                                                    variant='outlined'
                                                    startIcon={<IconCode size={14} />}
                                                    onClick={() => {
                                                        setActiveFlowData(flow)
                                                        setPreviewJsonOpen(true)
                                                    }}
                                                    sx={{
                                                        color: isDarkMode ? '#c4b5fd' : '#5e35b1',
                                                        borderColor: isDarkMode ? '#7c4dff' : '#b39ddb',
                                                        fontWeight: 600,
                                                        '&:hover': {
                                                            bgcolor: isDarkMode ? 'rgba(124, 77, 255, 0.1)' : '#f3e8ff'
                                                        }
                                                    }}
                                                >
                                                    View JSON
                                                </Button>
                                            </Stack>

                                            <Stack direction='row' flexWrap='wrap' gap={1} sx={{ mb: 2 }}>
                                                {flow.nodes?.map((nd, nIdx) => (
                                                    <Chip
                                                        key={nIdx}
                                                        size='small'
                                                        label={nd.name || nd.label || nd.id}
                                                        sx={{
                                                            bgcolor: colors.chipBg,
                                                            color: colors.chipText,
                                                            border: `1px solid ${colors.chipBorder}`,
                                                            fontWeight: 500
                                                        }}
                                                    />
                                                ))}
                                            </Stack>

                                            <Button
                                                fullWidth
                                                variant='contained'
                                                startIcon={<IconArrowRight size={18} />}
                                                onClick={() => handleLoadIntoCanvas(flow)}
                                                sx={{
                                                    fontWeight: 700,
                                                    py: 1.2,
                                                    bgcolor: isDarkMode ? '#7c4dff' : '#673ab7',
                                                    color: '#ffffff',
                                                    '&:hover': {
                                                        bgcolor: isDarkMode ? '#651fff' : '#5e35b1'
                                                    }
                                                }}
                                            >
                                                Open this Workflow in Canvas
                                            </Button>
                                        </Card>
                                    )}
                                </Box>
                            </Box>
                        )
                    })}

                    {/* Loading Indicator */}
                    {isLoading && (
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                            <Avatar
                                sx={{
                                    bgcolor: isDarkMode ? '#2563eb' : '#2196f3',
                                    color: '#ffffff',
                                    width: 36,
                                    height: 36
                                }}
                            >
                                <IconSparkles size={20} color='#ffffff' />
                            </Avatar>
                            <Card
                                sx={{
                                    p: 2,
                                    bgcolor: colors.assistantBg,
                                    border: `1px solid ${colors.assistantBorder}`,
                                    borderRadius: 2,
                                    boxShadow: isDarkMode ? '0 4px 14px rgba(0,0,0,0.25)' : '0 2px 8px rgba(0,0,0,0.04)'
                                }}
                            >
                                <Stack direction='row' spacing={1.5} alignItems='center'>
                                    <CircularProgress size={18} sx={{ color: isDarkMode ? '#a78bfa' : '#673ab7' }} />
                                    <Typography variant='body2' sx={{ color: colors.secondaryText, fontWeight: 500 }}>
                                        {currentProvider.name} is generating your Flowise workflow...
                                    </Typography>
                                </Stack>
                            </Card>
                        </Box>
                    )}
                    <div ref={messagesEndRef} />
                </Box>

                {/* Bottom Input Area */}
                <Box
                    sx={{
                        flexShrink: 0,
                        p: 2,
                        borderTop: `1px solid ${colors.border}`,
                        bgcolor: colors.inputBarBg
                    }}
                >
                    <Stack direction='row' spacing={1.5} alignItems='center'>
                        <OutlinedInput
                            fullWidth
                            multiline
                            maxRows={4}
                            size='small'
                            placeholder={
                                isProviderReady
                                    ? `Describe the workflow you want to create with ${currentProvider.name}...`
                                    : `Configure ${currentProvider.name} in settings to start chatting...`
                            }
                            value={inputPrompt}
                            disabled={isLoading || !isProviderReady}
                            onChange={(e) => setInputPrompt(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && !e.shiftKey) {
                                    e.preventDefault()
                                    handleSendMessage()
                                }
                            }}
                            sx={{
                                bgcolor: colors.inputFieldBg,
                                borderRadius: 2,
                                '& .MuiOutlinedInput-notchedOutline': {
                                    borderColor: colors.inputBorder
                                },
                                '&:hover .MuiOutlinedInput-notchedOutline': {
                                    borderColor: isDarkMode ? '#5a657c' : '#94a3b8'
                                },
                                '&.Mui-focused .MuiOutlinedInput-notchedOutline': {
                                    borderColor: isDarkMode ? '#7c4dff' : '#2196f3'
                                },
                                '& .MuiInputBase-input': {
                                    color: colors.inputText
                                },
                                '& input::placeholder, & textarea::placeholder': {
                                    color: `${colors.placeholder} !important`,
                                    opacity: '1 !important'
                                }
                            }}
                        />

                        <Button
                            variant='contained'
                            disabled={!inputPrompt.trim() || isLoading || !isProviderReady}
                            onClick={() => handleSendMessage()}
                            sx={{
                                height: 42,
                                px: 2.5,
                                borderRadius: 2,
                                minWidth: 48,
                                bgcolor:
                                    !inputPrompt.trim() || isLoading || !isProviderReady
                                        ? `${colors.sendBtnDisabledBg} !important`
                                        : `${colors.sendBtnBg} !important`,
                                color:
                                    !inputPrompt.trim() || isLoading || !isProviderReady
                                        ? `${colors.sendBtnDisabledColor} !important`
                                        : `${colors.sendBtnColor} !important`,
                                boxShadow: isDarkMode ? '0 2px 8px rgba(0,0,0,0.3)' : '0 2px 6px rgba(0,0,0,0.1)'
                            }}
                        >
                            <IconSend size={18} />
                        </Button>
                        <Tooltip title='Clear Chat'>
                            <span>
                                <IconButton
                                    onClick={() => {
                                        setMessages([
                                            {
                                                role: 'assistant',
                                                content: 'Chat history cleared. How can I help you build your next workflow?'
                                            }
                                        ])
                                        setActiveFlowData(null)
                                    }}
                                    disabled={messages.length <= 1}
                                    sx={{
                                        bgcolor: colors.trashBtnBg,
                                        border: `1px solid ${colors.trashBtnBorder}`,
                                        borderRadius: 2,
                                        p: 1.2,
                                        color: messages.length <= 1 ? colors.trashBtnDisabledColor : colors.trashBtnColor,
                                        '&:hover': {
                                            bgcolor: isDarkMode ? '#343a46' : '#e2e8f0'
                                        },
                                        '&.Mui-disabled': {
                                            color: `${colors.trashBtnDisabledColor} !important`,
                                            borderColor: isDarkMode ? '#2d3340' : '#f1f5f9'
                                        }
                                    }}
                                >
                                    <IconTrash size={18} />
                                </IconButton>
                            </span>
                        </Tooltip>
                    </Stack>
                </Box>
            </Box>
            {/* Ollama Settings Dialog */}
            <Dialog
                open={isSettingsOpen}
                onClose={() => setIsSettingsOpen(false)}
                maxWidth='sm'
                fullWidth
                PaperProps={{
                    sx: {
                        bgcolor: colors.cardBg,
                        border: `1px solid ${colors.cardBorder}`,
                        borderRadius: 2
                    }
                }}
            >
                <DialogTitle>
                    <Stack direction='row' justifyContent='space-between' alignItems='center'>
                        <Typography variant='h4' sx={{ color: colors.primaryText, fontWeight: 700 }}>
                            AI Provider & Settings
                        </Typography>
                        <IconButton size='small' onClick={() => setIsSettingsOpen(false)} sx={{ color: colors.secondaryText }}>
                            ×
                        </IconButton>
                    </Stack>
                </DialogTitle>
                <DialogContent dividers sx={{ borderColor: colors.border }}>
                    <Stack spacing={2.5}>
                        <Box>
                            <Typography variant='subtitle2' sx={{ mb: 0.5, fontWeight: 600, color: colors.primaryText }}>
                                AI Provider
                            </Typography>
                            <Select
                                fullWidth
                                size='small'
                                value={selectedProvider}
                                onChange={(e) => handleProviderChange(e.target.value)}
                                sx={{
                                    bgcolor: colors.inputFieldBg,
                                    borderRadius: 1,
                                    color: colors.inputText,
                                    '& .MuiOutlinedInput-notchedOutline': { borderColor: colors.inputBorder }
                                }}
                            >
                                {providers.map((p) => (
                                    <MenuItem key={p.id} value={p.id}>
                                        {p.name} {p.type === 'local' ? '(Local)' : '(Cloud)'}
                                    </MenuItem>
                                ))}
                            </Select>
                        </Box>

                        {currentProvider.type === 'local' ? (
                            <Box>
                                <Typography variant='subtitle2' sx={{ mb: 0.5, fontWeight: 600, color: colors.primaryText }}>
                                    Ollama Endpoint URL
                                </Typography>
                                <Stack direction='row' spacing={1}>
                                    <TextField
                                        fullWidth
                                        size='small'
                                        value={ollamaUrl}
                                        placeholder='http://localhost:11434'
                                        onChange={(e) => setOllamaUrl(e.target.value)}
                                        sx={{
                                            bgcolor: colors.inputFieldBg,
                                            borderRadius: 1,
                                            '& .MuiOutlinedInput-notchedOutline': { borderColor: colors.inputBorder },
                                            '& .MuiInputBase-input': { color: colors.inputText }
                                        }}
                                    />
                                    <Button
                                        variant='outlined'
                                        onClick={() => checkOllamaConnection(ollamaUrl)}
                                        disabled={isCheckingConnection}
                                        startIcon={isCheckingConnection ? <CircularProgress size={16} /> : <IconRefresh size={16} />}
                                        sx={{
                                            color: isDarkMode ? '#a78bfa' : '#673ab7',
                                            borderColor: isDarkMode ? '#7c4dff' : '#b39ddb',
                                            fontWeight: 600
                                        }}
                                    >
                                        Test
                                    </Button>
                                </Stack>
                                <Typography variant='caption' sx={{ color: colors.secondaryText, mt: 0.5, display: 'block' }}>
                                    Default: http://localhost:11434
                                </Typography>
                            </Box>
                        ) : (
                            <Box>
                                <Typography variant='subtitle2' sx={{ mb: 0.5, fontWeight: 600, color: colors.primaryText }}>
                                    Saved Flowise Credential ({currentProvider.name})
                                </Typography>
                                {availableCredentials.length > 0 ? (
                                    <Select
                                        fullWidth
                                        size='small'
                                        value={selectedCredentialId}
                                        onChange={(e) => {
                                            const credId = e.target.value
                                            setSelectedCredentialId(credId)
                                            localStorage.setItem(`canvaschat_${selectedProvider}_credential`, credId)
                                            fetchModelsForProvider(selectedProvider, { credentialId: credId })
                                        }}
                                        sx={{
                                            bgcolor: colors.inputFieldBg,
                                            borderRadius: 1,
                                            color: colors.inputText,
                                            '& .MuiOutlinedInput-notchedOutline': { borderColor: colors.inputBorder }
                                        }}
                                    >
                                        {availableCredentials.map((c) => (
                                            <MenuItem key={c.id} value={c.id}>
                                                {c.name}
                                            </MenuItem>
                                        ))}
                                    </Select>
                                ) : (
                                    <Typography
                                        variant='caption'
                                        sx={{ color: isDarkMode ? '#fb923c' : '#c2410c', mt: 0.5, display: 'block' }}
                                    >
                                        No saved credential found for {currentProvider.name}.{' '}
                                        <Button
                                            variant='text'
                                            size='small'
                                            onClick={() => {
                                                setIsSettingsOpen(false)
                                                navigate('/credentials')
                                            }}
                                            sx={{
                                                p: 0,
                                                minWidth: 0,
                                                fontSize: '0.75rem',
                                                fontWeight: 700,
                                                textDecoration: 'underline',
                                                color: isDarkMode ? '#a78bfa' : '#673ab7'
                                            }}
                                        >
                                            Add one in Flowise Credentials menu
                                        </Button>
                                    </Typography>
                                )}
                            </Box>
                        )}

                        <Box>
                            <Typography variant='subtitle2' sx={{ mb: 0.5, fontWeight: 600, color: colors.primaryText }}>
                                Model Name
                            </Typography>
                            {Array.isArray(availableModels) && availableModels.length > 0 ? (
                                <Select
                                    fullWidth
                                    size='small'
                                    value={selectedModel}
                                    onChange={(e) => {
                                        setSelectedModel(e.target.value)
                                        localStorage.setItem(`canvaschat_${selectedProvider}_model`, e.target.value)
                                    }}
                                    sx={{
                                        bgcolor: colors.inputFieldBg,
                                        borderRadius: 1,
                                        color: colors.inputText,
                                        '& .MuiOutlinedInput-notchedOutline': { borderColor: colors.inputBorder }
                                    }}
                                >
                                    {availableModels.map((modelName) => (
                                        <MenuItem key={modelName} value={modelName}>
                                            {modelName}
                                        </MenuItem>
                                    ))}
                                </Select>
                            ) : (
                                <TextField
                                    fullWidth
                                    size='small'
                                    placeholder='e.g. gpt-4o-mini, claude-3-5-sonnet-20241022, llama-3.3-70b-versatile'
                                    value={selectedModel}
                                    onChange={(e) => {
                                        setSelectedModel(e.target.value)
                                        localStorage.setItem(`canvaschat_${selectedProvider}_model`, e.target.value)
                                    }}
                                    sx={{
                                        bgcolor: colors.inputFieldBg,
                                        borderRadius: 1,
                                        '& .MuiOutlinedInput-notchedOutline': { borderColor: colors.inputBorder },
                                        '& .MuiInputBase-input': { color: colors.inputText }
                                    }}
                                />
                            )}
                        </Box>

                        <Box>
                            <Typography variant='subtitle2' sx={{ mb: 0.5, fontWeight: 600, color: colors.primaryText }}>
                                System Prompt (Instructions for JSON Output)
                            </Typography>
                            <TextField
                                fullWidth
                                multiline
                                rows={6}
                                size='small'
                                value={systemPrompt}
                                onChange={(e) => setSystemPrompt(e.target.value)}
                                sx={{
                                    bgcolor: colors.inputFieldBg,
                                    borderRadius: 1,
                                    '& .MuiOutlinedInput-notchedOutline': { borderColor: colors.inputBorder },
                                    '& .MuiInputBase-input': { color: colors.inputText, fontSize: '0.82rem' }
                                }}
                            />
                            <Button size='small' onClick={() => setSystemPrompt(DEFAULT_SYSTEM_PROMPT)} sx={{ mt: 0.5 }}>
                                Reset to Default Prompt
                            </Button>
                        </Box>

                        {currentProvider.type === 'local' && connectionError && (
                            <Box
                                sx={{
                                    p: 1.5,
                                    bgcolor: isDarkMode ? '#2d1808' : '#fef2f2',
                                    color: isDarkMode ? '#fdba74' : '#b91c1c',
                                    border: `1px solid ${isDarkMode ? '#7c2d12' : '#fecaca'}`,
                                    borderRadius: 1
                                }}
                            >
                                <Typography variant='caption' sx={{ display: 'block', whiteSpace: 'pre-wrap', fontWeight: 500 }}>
                                    {connectionError}
                                </Typography>
                            </Box>
                        )}
                    </Stack>
                </DialogContent>
                <DialogActions sx={{ p: 2, borderColor: colors.border }}>
                    <Button onClick={() => setIsSettingsOpen(false)} sx={{ fontWeight: 600 }}>
                        Done
                    </Button>
                </DialogActions>
            </Dialog>

            {/* Flow JSON Preview Dialog */}
            <Dialog
                open={previewJsonOpen}
                onClose={() => setPreviewJsonOpen(false)}
                maxWidth='md'
                fullWidth
                PaperProps={{
                    sx: {
                        bgcolor: colors.cardBg,
                        border: `1px solid ${colors.cardBorder}`,
                        borderRadius: 2
                    }
                }}
            >
                <DialogTitle>
                    <Stack direction='row' justifyContent='space-between' alignItems='center'>
                        <Typography variant='h4' sx={{ color: colors.primaryText, fontWeight: 700 }}>
                            Generated Flowise JSON
                        </Typography>
                        <IconButton size='small' onClick={() => setPreviewJsonOpen(false)} sx={{ color: colors.secondaryText }}>
                            ×
                        </IconButton>
                    </Stack>
                </DialogTitle>
                <DialogContent dividers sx={{ borderColor: colors.border }}>
                    <Box
                        component='pre'
                        sx={{
                            p: 2,
                            bgcolor: isDarkMode ? '#0d0f12' : '#1e1e1e',
                            color: '#e2e8f0',
                            borderRadius: 1.5,
                            border: `1px solid ${isDarkMode ? '#2f3542' : '#333333'}`,
                            overflow: 'auto',
                            maxHeight: '60vh',
                            fontSize: '0.85rem'
                        }}
                    >
                        {JSON.stringify(activeFlowData, null, 2)}
                    </Box>
                </DialogContent>
                <DialogActions sx={{ p: 2, borderColor: colors.border }}>
                    <Button
                        startIcon={<IconCopy size={16} />}
                        onClick={() => {
                            navigator.clipboard.writeText(JSON.stringify(activeFlowData, null, 2))
                            enqueueSnackbar({ message: 'JSON copied to clipboard!', options: { variant: 'success' } })
                        }}
                        sx={{ fontWeight: 600 }}
                    >
                        Copy JSON
                    </Button>
                    <Button
                        variant='contained'
                        startIcon={<IconArrowRight size={18} />}
                        onClick={() => {
                            setPreviewJsonOpen(false)
                            handleLoadIntoCanvas(activeFlowData)
                        }}
                        sx={{
                            fontWeight: 700,
                            bgcolor: isDarkMode ? '#7c4dff' : '#673ab7',
                            color: '#ffffff',
                            '&:hover': {
                                bgcolor: isDarkMode ? '#651fff' : '#5e35b1'
                            }
                        }}
                    >
                        Load into Canvas
                    </Button>
                </DialogActions>
            </Dialog>
        </Box>
    )
}

class CanvasChatErrorBoundary extends Component {
    constructor(props) {
        super(props)
        this.state = { hasError: false, error: null }
    }

    static getDerivedStateFromError(error) {
        return { hasError: true, error }
    }

    componentDidCatch(error, errorInfo) {
        console.error('CanvasChat uncaught error:', error, errorInfo)
    }

    render() {
        if (this.state.hasError) {
            return (
                <Box
                    sx={{
                        p: 4,
                        minHeight: '100vh',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        bgcolor: '#131518',
                        color: '#ffffff',
                        textAlign: 'center'
                    }}
                >
                    <IconAlertCircle size={48} color='#f87171' style={{ marginBottom: 16 }} />
                    <Typography variant='h3' sx={{ mb: 1, fontWeight: 700 }}>
                        Something went wrong loading Canvas AI Assistant
                    </Typography>
                    <Typography variant='body1' sx={{ color: '#9db0cb', mb: 3, maxWidth: 600 }}>
                        {this.state.error?.message || 'An unexpected rendering error occurred.'}
                    </Typography>
                    <Stack direction='row' spacing={2}>
                        <Button
                            variant='contained'
                            color='secondary'
                            onClick={() => (window.location.href = '/canvas')}
                            sx={{ fontWeight: 600 }}
                        >
                            Return to Canvas
                        </Button>
                        <Button
                            variant='outlined'
                            onClick={() => this.setState({ hasError: false, error: null })}
                            sx={{ color: '#ffffff', borderColor: '#40495a' }}
                        >
                            Retry
                        </Button>
                    </Stack>
                </Box>
            )
        }
        return this.props.children
    }
}

CanvasChatErrorBoundary.propTypes = {
    children: PropTypes.node
}

const CanvasChatWithBoundary = (props) => (
    <CanvasChatErrorBoundary>
        <CanvasChat {...props} />
    </CanvasChatErrorBoundary>
)

export default CanvasChatWithBoundary
