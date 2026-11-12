import { lazy } from 'react'

// project imports
import Loadable from '@/ui-component/loading/Loadable'
import MinimalLayout from '@/layout/MinimalLayout'

// canvas routing
const Canvas = Loadable(lazy(() => import('@/views/canvas')))
const MarketplaceCanvas = Loadable(lazy(() => import('@/views/marketplaces/MarketplaceCanvas')))
const CanvasChat = Loadable(lazy(() => import('@/views/canvaschat')))

// ==============================|| CANVAS ROUTING ||============================== //

const CanvasRoutes = {
    path: '/',
    element: <MinimalLayout />,
    children: [
        {
            path: '/canvas',
            element: <Canvas />
        },
        {
            path: '/canvas/:id',
            element: <Canvas />
        },
        {
            path: '/agentcanvas',
            element: <Canvas />
        },
        {
            path: '/agentcanvas/:id',
            element: <Canvas />
        },
        {
            path: '/marketplace/:id',
            element: <MarketplaceCanvas />
        },
        {
            path: '/canvas-chat',
            element: <CanvasChat />
        },
        {
            path: '/canvas-chat/:id',
            element: <CanvasChat />
        }
    ]
}

export default CanvasRoutes
