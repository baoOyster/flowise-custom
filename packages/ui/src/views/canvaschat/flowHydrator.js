import { cloneDeep } from 'lodash'
import { initNode } from '@/utils/genericHelper'

/**
 * Extracts a Flowise JSON structure from an LLM text response.
 * Looks for ```json ... ``` blocks or top-level JSON objects containing "nodes" or "edges".
 */
export const extractFlowFromResponse = (text) => {
    if (!text || typeof text !== 'string') return null

    // 1. Check for markdown code blocks (```json ... ``` or ``` ... ```)
    const jsonBlockRegex = /```(?:json)?\s*([\s\S]*?)```/gi
    let match
    while ((match = jsonBlockRegex.exec(text)) !== null) {
        try {
            const raw = match[1].trim()
            const parsed = JSON.parse(raw)
            if (parsed && (Array.isArray(parsed.nodes) || Array.isArray(parsed.edges))) {
                return parsed
            }
        } catch {
            // keep searching subsequent blocks
        }
    }

    // 2. Fallback: Search for outer curly braces containing "nodes"
    const firstBrace = text.indexOf('{')
    const lastBrace = text.lastIndexOf('}')
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        try {
            const candidate = text.substring(firstBrace, lastBrace + 1)
            const parsed = JSON.parse(candidate)
            if (parsed && (Array.isArray(parsed.nodes) || Array.isArray(parsed.edges))) {
                return parsed
            }
        } catch {
            // ignore
        }
    }

    return null
}

/**
 * Auto-heals topological errors common with smaller LLMs:
 * - Promotes conversationChain to conversationalRetrievalQAChain if vector store exists
 * - Fixes inverted edges (e.g. chain -> chatModel)
 * - Auto-wires missing canonical RAG connections
 */
const autoHealFlow = (rawFlow, componentNodes = []) => {
    if (!rawFlow || !Array.isArray(rawFlow.nodes)) return rawFlow

    const nodes = cloneDeep(rawFlow.nodes)
    const edges = Array.isArray(rawFlow.edges) ? cloneDeep(rawFlow.edges) : []

    const getNodeInfo = (node) => {
        const rawName = (node.name || node.data?.name || node.type || '').toLowerCase()
        const comp = Array.isArray(componentNodes)
            ? componentNodes.find(
                  (c) => c.name?.toLowerCase() === rawName || c.label?.toLowerCase() === rawName || c.type?.toLowerCase() === rawName
              )
            : null

        const category = (comp?.category || '').toLowerCase()
        const name = (comp?.name || rawName).toLowerCase()
        const id = node.id

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
    const hasEdgeToTarget = (targetId, inputName) => {
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

/**
 * Hydrates simplified or raw LLM-generated flow data into full Flowise ReactFlow canvas format.
 */
export const hydrateFlowData = (rawFlow, componentNodes = []) => {
    if (!rawFlow || !Array.isArray(rawFlow.nodes)) {
        return { nodes: [], edges: [] }
    }

    const healedFlow = autoHealFlow(rawFlow, componentNodes)
    const hydratedNodes = []
    const nodeIdToNodeMap = new Map()

    // 1. Hydrate Nodes
    healedFlow.nodes.forEach((node, index) => {
        const nodeId = node.id || `node_${index}`
        const nodeName = node.name || node.data?.name || node.type

        const comp = componentNodes.find(
            (c) =>
                c.name?.toLowerCase() === nodeName?.toLowerCase() ||
                c.label?.toLowerCase() === nodeName?.toLowerCase() ||
                c.type?.toLowerCase() === nodeName?.toLowerCase()
        )

        let nodeData = {}
        if (comp) {
            const clonedComp = cloneDeep(comp)
            nodeData = initNode(clonedComp, nodeId)
            const userInputs = node.inputs || node.data?.inputs || {}
            nodeData.inputs = {
                ...(nodeData.inputs || {}),
                ...userInputs
            }
        } else if (node.data && typeof node.data === 'object') {
            nodeData = {
                ...node.data,
                id: nodeId,
                inputs: node.data.inputs || node.inputs || {}
            }
        } else {
            nodeData = {
                id: nodeId,
                name: nodeName || 'customNode',
                label: node.label || nodeName || 'Custom Node',
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

        const hydratedNode = {
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

    // 2. Hydrate Edges
    const hydratedEdges = []
    const rawEdges = Array.isArray(healedFlow.edges) ? healedFlow.edges : []

    rawEdges.forEach((edge) => {
        const sourceId = edge.source
        const targetId = edge.target
        const sourceNode = nodeIdToNodeMap.get(sourceId)
        const targetNode = nodeIdToNodeMap.get(targetId)

        if (!sourceNode || !targetNode) return

        let targetHandle = edge.targetHandle
        let targetInputName = edge.targetInput

        // Match input anchor by name or source compatibility
        if (!targetHandle && targetNode.data.inputAnchors) {
            let matchedAnchor = null
            if (targetInputName) {
                matchedAnchor = targetNode.data.inputAnchors.find((anc) => anc.name?.toLowerCase() === targetInputName.toLowerCase())
            }
            if (!matchedAnchor && targetInputName) {
                matchedAnchor = targetNode.data.inputAnchors.find(
                    (anc) =>
                        anc.label?.toLowerCase() === targetInputName.toLowerCase() ||
                        anc.name?.toLowerCase().includes(targetInputName.toLowerCase())
                )
            }

            // Semantic compatibility matching based on source capabilities
            if (!matchedAnchor) {
                const srcBaseClasses = (sourceNode.data.baseClasses || []).map((b) => b.toLowerCase())
                const srcCat = (sourceNode.data.category || '').toLowerCase()

                if (srcBaseClasses.includes('basechatmodel') || srcBaseClasses.includes('baselanguagemodel') || srcCat === 'chat models') {
                    matchedAnchor = targetNode.data.inputAnchors.find(
                        (anc) => anc.name === 'model' || anc.type?.includes('BaseChatModel') || anc.type?.includes('BaseLanguageModel')
                    )
                } else if (srcBaseClasses.includes('basememory') || srcCat === 'memory') {
                    matchedAnchor = targetNode.data.inputAnchors.find((anc) => anc.name === 'memory' || anc.type?.includes('BaseMemory'))
                } else if (
                    srcBaseClasses.includes('baseretriever') ||
                    srcBaseClasses.includes('vectorstoreretriever') ||
                    srcCat === 'vector stores'
                ) {
                    matchedAnchor = targetNode.data.inputAnchors.find(
                        (anc) => anc.name === 'vectorStoreRetriever' || anc.type?.includes('BaseRetriever')
                    )
                } else if (srcBaseClasses.includes('textsplitter') || srcCat === 'text splitters') {
                    matchedAnchor = targetNode.data.inputAnchors.find(
                        (anc) => anc.name === 'textSplitter' || anc.type?.includes('TextSplitter')
                    )
                } else if (srcBaseClasses.includes('document') || srcCat === 'document loaders') {
                    matchedAnchor = targetNode.data.inputAnchors.find((anc) => anc.name === 'document' || anc.type?.includes('Document'))
                } else if (srcBaseClasses.includes('embeddings') || srcCat === 'embeddings') {
                    matchedAnchor = targetNode.data.inputAnchors.find(
                        (anc) => anc.name === 'embeddings' || anc.type?.includes('Embeddings')
                    )
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
            const outputs = sourceNode.data.outputAnchors || []
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
                const baseClasses = Array.isArray(sourceNode.data.baseClasses) ? sourceNode.data.baseClasses.join('|') : ''
                sourceHandle = `${sourceId}-output-${sourceNode.data.name}-${baseClasses}`
            }
        }

        // Wire target node input reference
        if (targetInputName && targetNode.data.inputs) {
            const instanceRef = `{{${sourceId}.data.instance}}`
            const isList = targetInputName === 'document' || targetInputName === 'tools'
            const existingVal = targetNode.data.inputs[targetInputName]
            if (isList) {
                const arr = Array.isArray(existingVal) ? existingVal : existingVal ? [existingVal] : []
                if (!arr.includes(instanceRef)) {
                    targetNode.data.inputs[targetInputName] = [...arr, instanceRef]
                }
            } else if (Array.isArray(existingVal)) {
                if (!existingVal.includes(instanceRef)) {
                    targetNode.data.inputs[targetInputName] = [...existingVal, instanceRef]
                }
            } else {
                targetNode.data.inputs[targetInputName] = instanceRef
            }
        }

        const edgeId = edge.id || `${sourceId}-${sourceHandle}-${targetId}-${targetHandle}`
        hydratedEdges.push({
            id: edgeId,
            source: sourceId,
            sourceHandle,
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
