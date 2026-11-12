import { StatusCodes } from 'http-status-codes'
import { cloneDeep } from 'lodash'
import { IComponentNodes } from '../../Interface'
import { INode, INodeParams, INodeOutputsValue } from 'flowise-components'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { getErrorMessage } from '../../errors/utils'
import { getProvider, listProviders } from './providers'

const WHITELIST_INPUT_TYPES = [
    'asyncOptions',
    'options',
    'multiOptions',
    'datagrid',
    'string',
    'number',
    'boolean',
    'password',
    'json',
    'code',
    'date',
    'file',
    'folder',
    'tabs',
    'conditionFunction'
]

interface INodeWithOutputs extends INode {
    outputs?: INodeOutputsValue[]
}

interface INodeCanvasData {
    name?: string
    label?: string
    version?: number
    type?: string
    category?: string
    baseClasses?: string[]
    description?: string
    inputParams?: unknown[]
    inputAnchors?: Array<{ id: string; name: string; label?: string; type?: string }>
    outputAnchors?: Array<{ id?: string; name?: string; label?: string; options?: Array<{ id: string; name?: string; label?: string }> }>
    inputs?: Record<string, unknown>
    outputs?: Record<string, unknown>
    id?: string
    selected?: boolean
    [key: string]: unknown
}

interface IRawFlowNode {
    id?: string
    name?: string
    label?: string
    type?: string
    inputs?: Record<string, unknown>
    position?: { x: number; y: number }
    data?: {
        name?: string
        inputs?: Record<string, unknown>
        [key: string]: unknown
    }
}

interface IRawFlowEdge {
    id?: string
    source: string
    target: string
    sourceHandle?: string
    targetHandle?: string
    targetInput?: string
}

interface IRawFlow {
    nodes: IRawFlowNode[]
    edges: IRawFlowEdge[]
}

interface IHydratedNode {
    id: string
    type: string
    position: { x: number; y: number }
    data: INodeCanvasData
}

interface IHydratedEdge {
    id: string
    source: string
    sourceHandle: string
    target: string
    targetHandle: string
    type: string
}

interface IHydratedFlow {
    nodes: IHydratedNode[]
    edges: IHydratedEdge[]
}

function getNodeOutputs(node: INode): INodeOutputsValue[] {
    const nodeWithOutputs = node as INodeWithOutputs
    if (nodeWithOutputs.outputs && Array.isArray(nodeWithOutputs.outputs)) {
        return nodeWithOutputs.outputs
    }
    if (node.output && Array.isArray(node.output)) {
        return node.output
    }
    return []
}

/**
 * Layer 1: Build a compact global index of all available Flowise components grouped by category
 */
function buildCategoryIndex(componentNodes: IComponentNodes): string {
    const categoryMap: Record<string, string[]> = {}
    for (const name in componentNodes) {
        const node = componentNodes[name]
        const cat = node.category || 'Other'
        if (!categoryMap[cat]) categoryMap[cat] = []
        categoryMap[cat].push(node.name)
    }

    const lines = Object.entries(categoryMap)
        .map(([cat, names]) => `- ${cat}: [${names.slice(0, 15).join(', ')}${names.length > 15 ? ', ...' : ''}]`)
        .join('\n')

    return `Available Flowise Components by Category:\n${lines}`
}

/**
 * Layer 2: Keyword-based Mini-RAG to find top relevant components for user's prompt
 */
function selectRelevantNodes(prompt: string, componentNodes: IComponentNodes, limit = 8): INode[] {
    const tokens = prompt
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length > 2)

    const scoredNodes: Array<{ node: INode; score: number }> = []

    for (const name in componentNodes) {
        const node = componentNodes[name]
        let score = 0
        const nodeName = (node.name || '').toLowerCase()
        const nodeLabel = (node.label || '').toLowerCase()
        const nodeCategory = (node.category || '').toLowerCase()
        const nodeDesc = (node.description || '').toLowerCase()

        for (const token of tokens) {
            if (nodeName === token) score += 10
            else if (nodeName.includes(token)) score += 5
            if (nodeLabel.includes(token)) score += 4
            if (nodeCategory.includes(token)) score += 3
            if (nodeDesc.includes(token)) score += 1
        }

        // Domain heuristic boosts
        if (tokens.some((t) => ['chat', 'bot', 'conversation'].includes(t))) {
            if (['chatOllama', 'conversationChain', 'bufferMemory'].includes(node.name)) score += 4
        }
        if (tokens.some((t) => ['rag', 'pdf', 'document', 'vector', 'search'].includes(t))) {
            if (['inMemoryVectorStore', 'chroma', 'ollamaEmbedding', 'conversationalRetrievalQAChain', 'pdfFile'].includes(node.name))
                score += 4
        }

        if (score > 0) {
            scoredNodes.push({ node, score })
        }
    }

    scoredNodes.sort((a, b) => b.score - a.score)
    return scoredNodes.slice(0, limit).map((s) => s.node)
}

/**
 * Layer 2: Format selected node signatures into concise prompt instructions
 */
function formatNodeSpecs(nodes: INode[]): string {
    if (!nodes.length) return ''
    const formatted = nodes
        .map((n) => {
            const inputs = (n.inputs || []).map((inp: INodeParams) => `${inp.name} (${inp.type})`).join(', ')
            const outputs =
                getNodeOutputs(n)
                    .map((out: INodeOutputsValue) => out.name)
                    .join(', ') ||
                n.type ||
                'instance'
            return `* ${n.name} (Category: ${n.category}):\n    - Inputs: [${inputs}]\n    - Outputs: [${outputs}]`
        })
        .join('\n')

    return `\nSpecifications for Components Matching Your Request:\n${formatted}`
}

/**
 * Layer 3: Extract JSON from markdown or raw curly braces
 */
function extractFlowFromResponse(text: string): IRawFlow | null {
    if (!text || typeof text !== 'string') return null

    // Markdown block
    const jsonBlockRegex = /```(?:json)?\s*([\s\S]*?)```/gi
    let match
    while ((match = jsonBlockRegex.exec(text)) !== null) {
        try {
            const raw = match[1].trim()
            const parsed = JSON.parse(raw) as unknown
            if (parsed && typeof parsed === 'object' && ('nodes' in parsed || 'edges' in parsed)) {
                return parsed as IRawFlow
            }
        } catch {
            // continue search
        }
    }

    // Outer brace fallback
    const firstBrace = text.indexOf('{')
    const lastBrace = text.lastIndexOf('}')
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        try {
            const candidate = text.substring(firstBrace, lastBrace + 1)
            const parsed = JSON.parse(candidate) as unknown
            if (parsed && typeof parsed === 'object' && ('nodes' in parsed || 'edges' in parsed)) {
                return parsed as IRawFlow
            }
        } catch {
            // ignore
        }
    }

    return null
}

/**
 * Layer 3: Server-side node initialization mirroring Flowise's ReactFlow canvas node structure
 */
function initServerNode(componentDef: INode, nodeId: string): INodeCanvasData {
    const inputAnchors: Array<{ id: string; name: string }> = []
    const inputParams: unknown[] = []
    const incoming = componentDef.inputs ? componentDef.inputs.length : 0

    const defaultInputs: Record<string, unknown> = {}

    for (let i = 0; i < incoming; i += 1) {
        const inp = componentDef.inputs![i]
        const newInput = {
            ...inp,
            id: `${nodeId}-input-${inp.name}-${inp.type}`
        }
        if (WHITELIST_INPUT_TYPES.includes(inp.type)) {
            inputParams.push(newInput)
            defaultInputs[inp.name] = inp.default ?? ''
        } else {
            inputAnchors.push({ id: newInput.id, name: inp.name })
            defaultInputs[inp.name] = ''
        }
    }

    const outputAnchors: Array<{ id?: string; options?: Array<{ id: string }> }> = []
    const rawOutputs = getNodeOutputs(componentDef)
    if (!componentDef.hideOutput) {
        if (rawOutputs.length > 0) {
            const options: Array<{ id: string }> = []
            for (let j = 0; j < rawOutputs.length; j += 1) {
                const out = rawOutputs[j]
                const baseClasses = (out.baseClasses ?? []).join('|')
                options.push({
                    id: `${nodeId}-output-${out.name}-${baseClasses}`
                })
            }
            outputAnchors.push({
                options
            })
        } else {
            const baseClasses = Array.isArray(componentDef.baseClasses) ? componentDef.baseClasses.join('|') : ''
            outputAnchors.push({
                id: `${nodeId}-output-${componentDef.name}-${baseClasses}`
            })
        }
    }

    return {
        id: nodeId,
        name: componentDef.name,
        label: componentDef.label,
        version: componentDef.version || 1,
        type: componentDef.type,
        category: componentDef.category,
        baseClasses: componentDef.baseClasses || [],
        description: componentDef.description || '',
        inputParams,
        inputAnchors,
        outputAnchors,
        inputs: defaultInputs,
        outputs: {}
    }
}

/**
 * Layer 3: Server-side Hydrator & Auto-Wiring
 */
interface INodeInfo {
    id: string
    name: string
    category: string
    isVectorStore: boolean
    isDocLoader: boolean
    isTextSplitter: boolean
    isEmbeddings: boolean
    isChatModel: boolean
    isMemory: boolean
    isChain: boolean
}

function autoHealFlow(rawFlow: IRawFlow, componentNodes: IComponentNodes): IRawFlow {
    if (!rawFlow || !Array.isArray(rawFlow.nodes)) return rawFlow

    const nodes = cloneDeep(rawFlow.nodes)
    const edges = Array.isArray(rawFlow.edges) ? cloneDeep(rawFlow.edges) : []

    const getNodeInfo = (node: IRawFlowNode): INodeInfo => {
        const rawName = (node.name || node.data?.name || node.type || '').toLowerCase()
        let matchedComp: INode | null = null
        for (const key in componentNodes) {
            const candidate = componentNodes[key]
            if (
                candidate.name?.toLowerCase() === rawName ||
                candidate.label?.toLowerCase() === rawName ||
                candidate.type?.toLowerCase() === rawName
            ) {
                matchedComp = candidate
                break
            }
        }

        const category = (matchedComp?.category || '').toLowerCase()
        const name = (matchedComp?.name || rawName).toLowerCase()
        const id = node.id || ''

        const isVectorStore =
            category === 'vector stores' ||
            ['qdrant', 'chroma', 'pinecone', 'inmemoryvectorstore', 'weaviate', 'faiss'].some((v) => name.includes(v))
        const isDocLoader =
            category === 'document loaders' || ['pdf', 'file', 'loader', 'scraper', 'cheerio', 'textfile'].some((d) => name.includes(d))
        const isTextSplitter = category === 'text splitters' || name.includes('splitter')
        const isEmbeddings = category === 'embeddings' || name.includes('embedding')
        const isChatModel =
            category === 'chat models' || ['chatollama', 'chatopenai', 'chatanthropic', 'chatgroq'].some((m) => name.includes(m))
        const isMemory = category === 'memory' || name.includes('memory')
        const isChain = category === 'chains' || name.includes('chain')

        return { id, name, category, isVectorStore, isDocLoader, isTextSplitter, isEmbeddings, isChatModel, isMemory, isChain }
    }

    const initialInfos = nodes.map(getNodeInfo)
    const hasVectorStore = initialInfos.some((n) => n.isVectorStore)

    // 1. Promote conversationChain -> conversationalRetrievalQAChain if a vector store is present
    if (hasVectorStore) {
        nodes.forEach((n) => {
            const rawName = (n.name || n.data?.name || n.type || '').toLowerCase()
            if (rawName === 'conversationchain') {
                n.name = 'conversationalRetrievalQAChain'
                if (n.data) n.data.name = 'conversationalRetrievalQAChain'
            }
        })
    }

    const refreshedInfos = nodes.map(getNodeInfo)
    const infoMap = new Map(refreshedInfos.map((n) => [n.id, n]))

    // 2. Fix inverted edges (e.g. chain -> chatModel)
    for (const edge of edges) {
        const src = infoMap.get(edge.source)
        const tgt = infoMap.get(edge.target)
        if (src && tgt) {
            if (src.isChain && (tgt.isChatModel || tgt.isMemory || tgt.isVectorStore)) {
                const temp = edge.source
                edge.source = edge.target
                edge.target = temp
                delete edge.sourceHandle
                delete edge.targetHandle
                if (tgt.isChatModel) edge.targetInput = 'model'
                else if (tgt.isMemory) edge.targetInput = 'memory'
                else if (tgt.isVectorStore) edge.targetInput = 'vectorStoreRetriever'
            }
        }
    }

    // Filter out invalid/incompatible edges (e.g. vectorStore -> model, or chatModel -> retriever)
    const validEdges = edges.filter((e) => {
        const src = infoMap.get(e.source)
        const tgt = infoMap.get(e.target)
        if (!src || !tgt) return true
        const inp = (e.targetInput || '').toLowerCase()
        if (src.isVectorStore && (inp === 'model' || inp === 'memory')) return false
        if (src.isChatModel && (inp === 'vectorstoreretriever' || inp === 'memory')) return false
        if (src.isMemory && (inp === 'model' || inp === 'vectorstoreretriever')) return false
        return true
    })

    // 3. Auto-link missing connections
    const hasEdgeToTarget = (targetId: string, inputName: string) => {
        return validEdges.some(
            (e) =>
                e.target === targetId &&
                (e.targetInput?.toLowerCase() === inputName.toLowerCase() ||
                    e.targetHandle?.toLowerCase()?.includes(inputName.toLowerCase()))
        )
    }

    const splitterNode = refreshedInfos.find((n) => n.isTextSplitter)
    const docLoaderNode = refreshedInfos.find((n) => n.isDocLoader)
    const vectorStoreNode = refreshedInfos.find((n) => n.isVectorStore)
    const embeddingsNode = refreshedInfos.find((n) => n.isEmbeddings)
    const chatModelNode = refreshedInfos.find((n) => n.isChatModel)
    const memoryNode = refreshedInfos.find((n) => n.isMemory)
    const qaChainNode = refreshedInfos.find(
        (n) => n.name.toLowerCase().includes('conversationalretrievalqachain') || (n.isChain && hasVectorStore)
    )
    const generalChainNode = refreshedInfos.find((n) => n.isChain)
    const chainTarget = qaChainNode || generalChainNode

    // Splitter -> Document Loader
    if (splitterNode && docLoaderNode && !hasEdgeToTarget(docLoaderNode.id, 'textSplitter')) {
        validEdges.push({ source: splitterNode.id, target: docLoaderNode.id, targetInput: 'textSplitter' })
    }

    // Document Loader -> Vector Store
    if (docLoaderNode && vectorStoreNode && !hasEdgeToTarget(vectorStoreNode.id, 'document')) {
        validEdges.push({ source: docLoaderNode.id, target: vectorStoreNode.id, targetInput: 'document' })
    }

    // Embeddings -> Vector Store
    if (embeddingsNode && vectorStoreNode && !hasEdgeToTarget(vectorStoreNode.id, 'embeddings')) {
        validEdges.push({ source: embeddingsNode.id, target: vectorStoreNode.id, targetInput: 'embeddings' })
    }

    // Vector Store -> Retrieval QA Chain
    if (vectorStoreNode && chainTarget && !hasEdgeToTarget(chainTarget.id, 'vectorStoreRetriever')) {
        validEdges.push({ source: vectorStoreNode.id, target: chainTarget.id, targetInput: 'vectorStoreRetriever' })
    }

    // Chat Model -> Chain
    if (chatModelNode && chainTarget && !hasEdgeToTarget(chainTarget.id, 'model')) {
        validEdges.push({ source: chatModelNode.id, target: chainTarget.id, targetInput: 'model' })
    }

    // Memory -> Chain
    if (memoryNode && chainTarget && !hasEdgeToTarget(chainTarget.id, 'memory')) {
        validEdges.push({ source: memoryNode.id, target: chainTarget.id, targetInput: 'memory' })
    }

    return { nodes, edges: validEdges }
}

function hydrateFlow(rawFlow: IRawFlow, componentNodes: IComponentNodes): IHydratedFlow {
    if (!rawFlow || !Array.isArray(rawFlow.nodes)) {
        return { nodes: [], edges: [] }
    }

    const healedFlow = autoHealFlow(rawFlow, componentNodes)
    const hydratedNodes: IHydratedNode[] = []
    const nodeIdToNodeMap = new Map<string, IHydratedNode>()

    // 1. Hydrate nodes
    healedFlow.nodes.forEach((node, index) => {
        const nodeId = node.id || `node_${index}`
        const rawName = node.name || node.data?.name || node.type || ''

        // Fuzzy match component in catalog
        let matchedComp: INode | null = null
        for (const key in componentNodes) {
            const candidate = componentNodes[key]
            if (
                candidate.name?.toLowerCase() === rawName.toLowerCase() ||
                candidate.label?.toLowerCase() === rawName.toLowerCase() ||
                candidate.type?.toLowerCase() === rawName.toLowerCase()
            ) {
                matchedComp = candidate
                break
            }
        }

        let nodeData: INodeCanvasData = {}
        if (matchedComp) {
            nodeData = initServerNode(cloneDeep(matchedComp), nodeId)
            const userInputs = node.inputs || node.data?.inputs || {}
            const existingInputs = (nodeData.inputs || {}) as Record<string, unknown>
            nodeData.inputs = {
                ...existingInputs,
                ...userInputs
            }
        } else {
            nodeData = {
                id: nodeId,
                name: rawName,
                label: node.label || rawName,
                inputAnchors: [],
                inputParams: [],
                outputAnchors: [],
                inputs: node.inputs || {}
            }
        }

        // Topological column position layout
        let defaultPos = { x: 80 + (index % 3) * 360, y: 120 + Math.floor(index / 3) * 280 }
        const cat = (nodeData.category || '').toLowerCase()
        const nName = (nodeData.name || '').toLowerCase()
        if (cat === 'text splitters' || nName.includes('splitter')) {
            defaultPos = { x: 80, y: 100 }
        } else if (cat === 'document loaders' || nName.includes('file') || nName.includes('loader')) {
            defaultPos = { x: 80, y: 380 }
        } else if (cat === 'embeddings' || nName.includes('embedding')) {
            defaultPos = { x: 440, y: 100 }
        } else if (cat === 'vector stores' || nName.includes('vector') || ['qdrant', 'chroma', 'pinecone'].some((v) => nName.includes(v))) {
            defaultPos = { x: 440, y: 380 }
        } else if (cat === 'chat models' || nName.startsWith('chat')) {
            defaultPos = { x: 800, y: 100 }
        } else if (cat === 'memory' || nName.includes('memory')) {
            defaultPos = { x: 800, y: 440 }
        } else if (cat === 'chains' || nName.includes('chain')) {
            defaultPos = { x: 1180, y: 240 }
        }

        const hydratedNode: IHydratedNode = {
            id: nodeId,
            type: 'customNode',
            position: node.position && typeof node.position.x === 'number' ? node.position : defaultPos,
            data: {
                ...nodeData,
                id: nodeId,
                selected: false
            }
        }

        hydratedNodes.push(hydratedNode)
        nodeIdToNodeMap.set(nodeId, hydratedNode)
    })

    // 2. Hydrate edges
    const hydratedEdges: IHydratedEdge[] = []
    const rawEdges = Array.isArray(healedFlow.edges) ? healedFlow.edges : []

    rawEdges.forEach((edge) => {
        const sourceId = edge.source
        const targetId = edge.target
        const sourceNode = nodeIdToNodeMap.get(sourceId)
        const targetNode = nodeIdToNodeMap.get(targetId)

        if (!sourceNode || !targetNode) return

        const sourceData = sourceNode.data
        const targetData = targetNode.data

        let targetHandle = edge.targetHandle
        let targetInputName = edge.targetInput

        // Match input anchor by name or source compatibility
        if (!targetHandle && targetData.inputAnchors) {
            let matchedAnchor = null
            if (targetInputName) {
                matchedAnchor = targetData.inputAnchors.find((anc) => anc.name?.toLowerCase() === targetInputName?.toLowerCase())
            }
            if (!matchedAnchor && targetInputName) {
                matchedAnchor = targetData.inputAnchors.find(
                    (anc) =>
                        anc.name?.toLowerCase().includes(targetInputName?.toLowerCase() || '') ||
                        anc.label?.toLowerCase() === targetInputName?.toLowerCase()
                )
            }

            // Semantic compatibility matching based on source capabilities
            if (!matchedAnchor) {
                const srcBaseClasses = (sourceNode.data.baseClasses || []).map((b) => b.toLowerCase())
                const srcCat = (sourceNode.data.category || '').toLowerCase()

                if (srcBaseClasses.includes('basechatmodel') || srcBaseClasses.includes('baselanguagemodel') || srcCat === 'chat models') {
                    matchedAnchor = targetData.inputAnchors.find((anc) => anc.name === 'model' || anc.type?.includes('BaseChatModel'))
                } else if (srcBaseClasses.includes('basememory') || srcCat === 'memory') {
                    matchedAnchor = targetData.inputAnchors.find((anc) => anc.name === 'memory' || anc.type?.includes('BaseMemory'))
                } else if (
                    srcBaseClasses.includes('baseretriever') ||
                    srcBaseClasses.includes('vectorstoreretriever') ||
                    srcCat === 'vector stores'
                ) {
                    matchedAnchor = targetData.inputAnchors.find(
                        (anc) => anc.name === 'vectorStoreRetriever' || anc.type?.includes('BaseRetriever')
                    )
                } else if (srcBaseClasses.includes('textsplitter') || srcCat === 'text splitters') {
                    matchedAnchor = targetData.inputAnchors.find((anc) => anc.name === 'textSplitter' || anc.type?.includes('TextSplitter'))
                } else if (srcBaseClasses.includes('document') || srcCat === 'document loaders') {
                    matchedAnchor = targetData.inputAnchors.find((anc) => anc.name === 'document' || anc.type?.includes('Document'))
                } else if (srcBaseClasses.includes('embeddings') || srcCat === 'embeddings') {
                    matchedAnchor = targetData.inputAnchors.find((anc) => anc.name === 'embeddings' || anc.type?.includes('Embeddings'))
                }
            }

            if (matchedAnchor) {
                targetHandle = matchedAnchor.id
                targetInputName = matchedAnchor.name
            }
        }

        if (!targetHandle) {
            targetInputName = targetInputName || 'model'
            targetHandle = `${targetId}-input-${targetInputName}`
        } else if (!targetInputName) {
            const parts = targetHandle.split('-')
            if (parts.length >= 3) {
                targetInputName = parts[2]
            }
        }

        // Resolve sourceHandle
        let sourceHandle = edge.sourceHandle
        if (!sourceHandle) {
            const outputs = sourceData.outputAnchors || []
            if (outputs.length > 0) {
                // If connecting to a retriever input, select the retriever option
                if (targetInputName === 'vectorStoreRetriever' && outputs[0].options && outputs[0].options.length > 0) {
                    const retOpt = outputs[0].options.find(
                        (opt) => opt.name?.toLowerCase().includes('retriever') || opt.id?.toLowerCase().includes('retriever')
                    )
                    if (retOpt) sourceHandle = retOpt.id
                }
                if (!sourceHandle && outputs[0].options && outputs[0].options.length > 0) {
                    sourceHandle = outputs[0].options[0].id
                } else if (!sourceHandle && outputs[0].id) {
                    sourceHandle = outputs[0].id
                }
            }
            if (!sourceHandle) {
                const baseClasses = Array.isArray(sourceData.baseClasses) ? sourceData.baseClasses.join('|') : ''
                sourceHandle = `${sourceId}-output-${sourceData.name || sourceId}-${baseClasses}`
            }
        }

        if (targetInputName && targetData.inputs) {
            const instanceRef = `{{${sourceId}.data.instance}}`
            const isList = targetInputName === 'document' || targetInputName === 'tools'
            const existingVal = targetData.inputs[targetInputName]
            if (isList) {
                const arr = Array.isArray(existingVal) ? existingVal : existingVal ? [existingVal] : []
                if (!arr.includes(instanceRef)) {
                    targetData.inputs[targetInputName] = [...arr, instanceRef]
                }
            } else if (Array.isArray(existingVal)) {
                if (!existingVal.includes(instanceRef)) {
                    targetData.inputs[targetInputName] = [...existingVal, instanceRef]
                }
            } else {
                targetData.inputs[targetInputName] = instanceRef
            }
        }

        const edgeId = edge.id || `${sourceId}-${sourceHandle}-${targetId}-${targetHandle}`
        hydratedEdges.push({
            id: edgeId,
            source: sourceId,
            sourceHandle: sourceHandle || '',
            target: targetId,
            targetHandle,
            type: 'buttonedge'
        })
    })

    return {
        nodes: hydratedNodes,
        edges: hydratedEdges
    }
}

// ==============================|| SERVICE API ||============================== //

/**
 * List available LLM providers
 */
const getProviders = () => {
    return listProviders()
}

/**
 * Fetch available models for a given provider
 */
const getProviderModels = async (providerId: string, options: { url?: string; credentialId?: string }): Promise<string[]> => {
    const provider = getProvider(providerId)
    return await provider.getModels(options)
}

/**
 * Process canvas chat with Layers 1, 2, and 3 orchestration across any supported provider
 */
const chatWithProvider = async (body: {
    provider?: string
    model: string
    prompt: string
    messages: Array<{ role: string; content: string }>
    url?: string
    credentialId?: string
    systemPrompt?: string
}): Promise<{ message: string; flowData: IHydratedFlow | null }> => {
    try {
        const providerId = body.provider || 'ollama'
        const provider = getProvider(providerId)
        // Resolved lazily at call time to prevent circular dependency during module evaluation:
        // route -> controller -> service -> getRunningExpressApp -> index -> routes
        let appServer = null
        try {
            const { getRunningExpressApp } = require('../../utils/getRunningExpressApp')
            appServer = getRunningExpressApp()
        } catch {
            // Server instance might not be initialized in standalone or test environments
        }
        const componentNodes = appServer?.nodesPool?.componentNodes || {}

        // Layer 1: Global Category Index
        const categoryIndex = buildCategoryIndex(componentNodes)

        // Layer 2: Contextual Mini-RAG (Top relevant node specs)
        const relevantNodes = selectRelevantNodes(body.prompt, componentNodes, 8)
        const nodeSpecs = formatNodeSpecs(relevantNodes)

        // Assemble enriched system prompt
        const enrichedSystemPrompt = `${body.systemPrompt || 'You are an expert Flowise AI Workflow generator.'}

${categoryIndex}

${nodeSpecs}

Canonical Workflow Architecture Patterns:
1. Conversational Chatbot:
   - chatModel -> conversationChain (targetInput: "model")
   - bufferMemory -> conversationChain (targetInput: "memory")

2. Document Q&A / RAG with Vector Store:
   - textSplitter -> documentLoader (targetInput: "textSplitter")
   - documentLoader -> vectorStore (targetInput: "document")
   - embeddings -> vectorStore (targetInput: "embeddings")
   - vectorStore -> conversationalRetrievalQAChain (targetInput: "vectorStoreRetriever")
   - chatModel -> conversationalRetrievalQAChain (targetInput: "model")
   - bufferMemory -> conversationalRetrievalQAChain (targetInput: "memory")

Critical Rules:
1. For Document Q&A / RAG: ALWAYS use "conversationalRetrievalQAChain" (NEVER "conversationChain").
2. Wrap the workflow JSON inside a \`\`\`json markdown block.
3. Every node must have a unique 'id' and valid Flowise 'name'.
4. Every edge must define 'source', 'target', and 'targetInput'.
5. Provide a brief explanation of how the workflow operates.`
        const messages = [
            { role: 'system', content: enrichedSystemPrompt },
            ...(body.messages || []).map((m) => ({ role: m.role, content: m.content }))
        ]

        // Execute LLM call via provider adapter
        const assistantReply = await provider.invoke(messages, {
            model: body.model,
            url: body.url,
            credentialId: body.credentialId
        })

        // Layer 3: Extraction, Fuzzy Resolution, and Auto-Wiring
        const rawFlow = extractFlowFromResponse(assistantReply)
        let hydratedFlow: IHydratedFlow | null = null
        if (rawFlow) {
            hydratedFlow = hydrateFlow(rawFlow, componentNodes)
        }

        return {
            message: assistantReply,
            flowData: hydratedFlow
        }
    } catch (error) {
        if (error instanceof InternalFlowiseError) {
            throw error
        }
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, `Error in canvas-chat service: ${getErrorMessage(error)}`)
    }
}

export default {
    listProviders: getProviders,
    getProviderModels,
    chatWithProvider
}
