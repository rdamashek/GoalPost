'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@apollo/client'
import { ApolloWrapper } from '@/components'
import { Box, Stack } from '@chakra-ui/react'
import {
  GET_ALL_PEOPLE,
  GET_ALL_COREVALUES,
  GET_ALL_GOALS,
  GET_ALL_RESOURCES,
  GET_ALL_COMMUNITIES,
  GET_ALL_CAREPOINTS,
} from '@/app/graphql'
import GraphSideBar from '@/components/ui/graph-sidebar'

import type { Node, Relationship } from '@neo4j-nvl/base'
import { InteractiveNvlWrapper } from '@neo4j-nvl/react'
import type { MouseEventCallbacks } from '@neo4j-nvl/react'
import GraphControls from '@/components/ui/graph-controls'
import styles from './graph-viz.module.css'

interface SelectedNodeInfo extends Node {
  properties?: {
    id: string
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nodeInfo: any
    nodeName: string
  }
}

interface SelectedRelationship extends Relationship {
  size?: number
}
const initialSelectedNodeInfo: SelectedNodeInfo[] = []

const NodeTriggers = [
  'Resource',
  'Person',
  'Community',
  'CoreValue',
  'Goal',
  'CarePoint',
]

const GraphVisualization = () => {
  const { data, loading, error } = useQuery(GET_ALL_PEOPLE)
  const { data: people } = useQuery(GET_ALL_PEOPLE)
  const { data: coreValues } = useQuery(GET_ALL_COREVALUES)
  const { data: goals } = useQuery(GET_ALL_GOALS)
  const { data: resources } = useQuery(GET_ALL_RESOURCES)
  const { data: communities } = useQuery(GET_ALL_COMMUNITIES)
  const { data: carePoints } = useQuery(GET_ALL_CAREPOINTS)
  const [selectedNodeInfo, setSelectedNodeInfo] = useState(
    initialSelectedNodeInfo
  )
  const [relationships, setRelationships] = useState<Relationship[]>([])

  const graphControlsRef = React.useRef<HTMLDivElement>(null)

  const peopleNodes = useMemo(() => {
    return (
      people?.people.map((person) => ({
        id: `Person-${person.id}`,
        color: '#8ea9f0',
        size: 15,
        caption: person.name,
        properties: {
          nodeInfo: {
            Entity: 'Person',
            Name: person.name,
            'First Name': person.firstName,
            'Phone Number': person.phone,
            Pronouns: person.pronouns,
          },
          nodeName: person.__typename,
          id: person.id,
        },
      })) ?? []
    )
  }, [people])

  const coreValuesNodes = useMemo(() => {
    return (
      coreValues?.coreValues.map((coreValue) => ({
        id: `CoreValue-${coreValue.id}`,
        color: '#64ebdf',
        size: 15,
        caption: coreValue.name,
        properties: {
          nodeInfo: {
            Entity: 'Core Value',
            Name: coreValue.name,
            Description: coreValue.description,
          },
          nodeName: coreValue.__typename,
          id: coreValue.id,
        },
      })) ?? []
    )
  }, [coreValues])

  const goalNodes = useMemo(() => {
    return (
      goals?.goals.map((goal) => ({
        id: `Goal-${goal.id}`,
        color: '#edcc91',
        size: 15,
        caption: goal.name,
        properties: {
          nodeInfo: {
            Entity: 'Goal',
            Name: goal.name,
            Description: goal.description,
            Status: goal.status,
          },
          nodeName: goal.__typename,
          id: goal.id,
        },
      })) ?? []
    )
  }, [goals])

  const carePointsNodes = useMemo(() => {
    return (
      carePoints?.carePoints.map((carePoint) => ({
        id: `CarePoint-${carePoint.id}`,
        color: '#61cfed',
        size: 15,
        caption: carePoint.name,
        properties: {
          nodeInfo: {
            Entity: 'Care Point',
            Name: carePoint.name,
            Description: carePoint.description,
            Status: carePoint.status,
          },
          nodeName: carePoint.__typename,
          id: carePoint.id,
        },
      })) ?? []
    )
  }, [carePoints])

  const resourceNodes = useMemo(() => {
    return (
      resources?.resources.map((resource) => ({
        id: `Resource-${resource.id}`,
        color: '#c392ee',
        size: 15,
        caption: resource.name,
        properties: {
          nodeInfo: {
            Entity: 'Resource',
            Name: resource.name,
            Description: resource.description,
            Status: resource.status,
          },
          nodeName: resource.__typename,
          id: resource.id,
        },
      })) ?? []
    )
  }, [resources])

  const communityNodes = useMemo(() => {
    return (
      communities?.communities.map((community) => ({
        id: `Community-${community.id}`,
        color: '#91edb4',
        size: 15,
        caption: community.name,
        properties: {
          nodeInfo: {
            Entity: 'Community',
            Name: community.name,
            Description: community.description,
            Status: community.status,
          },
          nodeName: community.__typename,
          id: community.id,
        },
      })) ?? []
    )
  }, [communities])

  const graphNodes = useMemo(() => {
    return [
      ...resourceNodes,
      ...peopleNodes,
      ...coreValuesNodes,
      ...goalNodes,
      ...communityNodes,
      ...carePointsNodes,
    ]
  }, [
    resourceNodes,
    peopleNodes,
    coreValuesNodes,
    goalNodes,
    communityNodes,
    carePointsNodes,
  ])

  const [selectedNodes, setSelectedNodes] = useState<SelectedNodeInfo[]>([])

  const personToPersonConnection = useMemo(() => {
    if (!people?.people) return []

    const edges: SelectedRelationship[] = []
    const seen = new Set()

    people.people.forEach((person) => {
      person.connections?.forEach((connection) => {
        const [first, second] = [person.id, connection.id].sort()
        const key = `${first}-${second}`

        if (!seen.has(key)) {
          seen.add(key)
          edges.push({
            id: `${person.id}-${connection.id}`,
            from: `Person-${person.id}`,
            to: `Person-${connection.id}`,
            caption: 'CONNECTED TO',
            captionSize: 0.75,
            width: 0.5,
          })
        }
      })
    })
    return edges
  }, [people])

  const personToCommunityConnection = useMemo(() => {
    return (
      people?.people.flatMap((person) => {
        return person.communities
          ? person.communities.map((community) => ({
              id: `${person.id}-${community.id}`,
              from: `Person-${person.id}`,
              to: `Community-${community.id}`,
              caption: 'BELONGS TO',
              captionSize: 0.75,
              width: 0.5,
            }))
          : []
      }) ?? []
    )
  }, [people])

  const personToGoalsConnection = useMemo(() => {
    return (
      people?.people.flatMap((person) => {
        return person.goals
          ? person.goals.map((goal) => ({
              id: `${person.id}-${goal.id}`,
              from: `Person-${person.id}`,
              to: `Goal-${goal.id}`,
              caption: 'MOTIVATED BY',
              captionSize: 0.75,
              width: 0.5,
            }))
          : []
      }) ?? []
    )
  }, [people])

  const personToCoreValueConnection = useMemo(() => {
    return (
      people?.people.flatMap((person) => {
        return person.coreValues
          ? person.coreValues.map((coreValue) => ({
              id: `${person.id}-${coreValue.id}`,
              from: `Person-${person.id}`,
              to: `CoreValue-${coreValue.id}`,
              caption: 'EMBRACES',
              captionSize: 0.75,
              width: 0.5,
            }))
          : []
      }) ?? []
    )
  }, [people])

  const personToCarePointConnection = useMemo(() => {
    return (
      people?.people.flatMap((person) => {
        return person.carePoints
          ? person.carePoints.map((carePoint) => ({
              id: `${person.id}-${carePoint.id}`,
              from: `Person-${person.id}`,
              to: `CarePoint-${carePoint.id}`,
              caption: 'ENABLES CARE',
              captionSize: 0.75,
              width: 0.5,
            }))
          : []
      }) ?? []
    )
  }, [people])

  const personToResourceConnection = useMemo(() => {
    return (
      people?.people.flatMap((person) => {
        return person.providesResources
          ? person.providesResources.map((resource) => ({
              id: `${person.id}-${resource.id}`,
              from: `Person-${person.id}`,
              to: `Resource-${resource.id}`,
              caption: 'PROVIDES',
              captionSize: 0.75,
              width: 0.5,
            }))
          : []
      }) ?? []
    )
  }, [people])

  const communityToCommunityConnection = useMemo(() => {
    if (!communities?.communities) return []

    const edges: SelectedRelationship[] = []
    const seen = new Set()

    communities.communities.forEach((community) => {
      community.relatedCommunities?.forEach((relatedCommunity) => {
        const [first, second] = [community.id, relatedCommunity.id].sort()
        const key = `${first}-${second}`

        if (!seen.has(key)) {
          seen.add(key)
          edges.push({
            id: `${community.id}-${relatedCommunity.id}`,
            from: `Community-${community.id}`,
            to: `Community-${relatedCommunity.id}`,
            caption: 'CONNECTED TO',
            captionSize: 0.75,
            width: 0.5,
          })
        }
      })
    })
    return edges
  }, [communities])

  const communityToGoalsConnection = useMemo(() => {
    return (
      communities?.communities.flatMap((community) => {
        return community.goals
          ? community.goals.map((goal) => ({
              id: `${community.id}-${goal.id}`,
              from: `Community-${community.id}`,
              to: `Goal-${goal.id}`,
              caption: 'MOTIVATED BY',
              captionSize: 0.75,
              width: 0.5,
            }))
          : []
      }) ?? []
    )
  }, [communities])

  const communityToCoreValueConnection = useMemo(() => {
    return (
      communities?.communities.flatMap((community) => {
        return community.coreValues
          ? community.coreValues.map((coreValue) => ({
              id: `${community.id}-${coreValue.id}`,
              from: `Community-${community.id}`,
              to: `CoreValue-${coreValue.id}`,
              caption: 'EMBRACES',
              captionSize: 0.75,
              width: 0.5,
            }))
          : []
      }) ?? []
    )
  }, [communities])

  const communityToResourcesConnection = useMemo(() => {
    return (
      communities?.communities.flatMap((community) => {
        return community.resources
          ? community.resources.map((resource) => ({
              id: `${community.id}-${resource.id}`,
              from: `Community-${community.id}`,
              to: `Resource-${resource.id}`,
              caption: 'PROVIDES',
              captionSize: 0.75,
              width: 0.5,
            }))
          : []
      }) ?? []
    )
  }, [communities])

  const goalToCarePointsConnection = useMemo(() => {
    return (
      carePoints?.carePoints.flatMap((carePoint) => {
        return carePoint.enabledByGoals
          ? carePoint.enabledByGoals.map((goal) => ({
              id: `${goal.id}-${carePoint.id}`,
              from: `Goal-${goal.id}`,
              to: `CarePoint-${carePoint.id}`,
              caption: 'ENABLES CARE',
              captionSize: 0.75,
              width: 0.5,
            }))
          : []
      }) ?? []
    )
  }, [carePoints])

  const goalToResourcesConnection = useMemo(() => {
    return (
      goals?.goals.flatMap((goal) => {
        return goal.resources
          ? goal.resources.map((resource) => ({
              id: `${goal.id}-${resource.id}`,
              from: `Goal-${goal.id}`,
              to: `Resource-${resource.id}`,
              caption: 'PROVIDES',
              captionSize: 0.75,
              width: 0.5,
            }))
          : []
      }) ?? []
    )
  }, [goals])

  const carePointToGoalsConnection = useMemo(() => {
    return (
      carePoints?.carePoints.flatMap((carePoint) => {
        return carePoint.caresForGoals
          ? carePoint.caresForGoals.map((goal) => ({
              id: `${carePoint.id}-${goal.id}`,
              from: `CarePoint-${carePoint.id}`,
              to: `Goal-${goal.id}`,
              caption: 'CARES FOR',
              captionSize: 0.75,
              width: 0.5,
            }))
          : []
      }) ?? []
    )
  }, [carePoints])

  const mouseEventCallbacks: MouseEventCallbacks = {
    // onRelationshipRightClick: (rel: Relationship, hitTargets: HitTargets, evt: MouseEvent) => { },
    onNodeClick: (node: Node) => {
      if (selectedNodeInfo[0]?.id === node.id) {
        setSelectedNodeInfo([])
      } else {
        setSelectedNodeInfo([node])
      }
    },
    // onNodeRightClick: (node: Node, hitTargets: HitTargets, evt: MouseEvent) => { },
    // onNodeDoubleClick: (node: Node, hitTargets: HitTargets, evt: MouseEvent) => { },
    // onRelationshipClick: (rel: Relationship, hitTargets: HitTargets, evt: MouseEvent) => { console.log('rel', rel.id) },
    // onRelationshipDoubleClick: (rel: Relationship, hitTargets: HitTargets, evt: MouseEvent) => { },
    onCanvasClick: () => {
      setSelectedNodeInfo([])
    },
    // onCanvasDoubleClick: (evt: MouseEvent) => console.log('onCanvasDoubleClick', evt),
    // onCanvasRightClick: (evt: MouseEvent) => { },
    onDrag: () => {},
    onPan: () => {},
    onZoom: () => {},
  }

  const nodeInfo = selectedNodeInfo[0]?.properties?.nodeInfo
  const nodeId = selectedNodeInfo[0]?.properties?.id
  const nodeName = selectedNodeInfo[0]?.properties?.nodeName

  useEffect(() => {
    const selectedNodeIds = selectedNodes.map((node) => node.id)

    const filteredRelationships = [
      ...(selectedNodeIds.some((id) =>
        peopleNodes.some((node) => node.id === id)
      )
        ? [...personToPersonConnection]
        : []),

      ...(selectedNodeIds.some((id) =>
        peopleNodes.some((node) => node.id === id)
      ) &&
      selectedNodeIds.some((id) =>
        communityNodes.some((node) => node.id === id)
      )
        ? personToCommunityConnection
        : []),
      ...(selectedNodeIds.some((id) =>
        peopleNodes.some((node) => node.id === id)
      ) &&
      selectedNodeIds.some((id) => goalNodes.some((node) => node.id === id))
        ? personToGoalsConnection
        : []),
      ...(selectedNodeIds.some((id) =>
        peopleNodes.some((node) => node.id === id)
      ) &&
      selectedNodeIds.some((id) =>
        coreValuesNodes.some((node) => node.id === id)
      )
        ? personToCoreValueConnection
        : []),

      ...(selectedNodeIds.some((id) =>
        peopleNodes.some((node) => node.id === id)
      ) &&
      selectedNodeIds.some((id) =>
        carePointsNodes.some((node) => node.id === id)
      )
        ? personToCarePointConnection
        : []),

      ...(selectedNodeIds.some((id) =>
        peopleNodes.some((node) => node.id === id)
      ) &&
      selectedNodeIds.some((id) => resourceNodes.some((node) => node.id === id))
        ? personToResourceConnection
        : []),
      ...(selectedNodeIds.some((id) =>
        communityNodes.some((node) => node.id === id)
      )
        ? communityToCommunityConnection
        : []),
      ...(selectedNodeIds.some((id) =>
        communityNodes.some((node) => node.id === id)
      ) &&
      selectedNodeIds.some((id) =>
        coreValuesNodes.some((node) => node.id === id)
      )
        ? communityToCoreValueConnection
        : []),

      ...(selectedNodeIds.some((id) =>
        communityNodes.some((node) => node.id === id)
      ) &&
      selectedNodeIds.some((id) => goalNodes.some((node) => node.id === id))
        ? communityToGoalsConnection
        : []),

      ...(selectedNodeIds.some((id) =>
        communityNodes.some((node) => node.id === id)
      ) &&
      selectedNodeIds.some((id) => resourceNodes.some((node) => node.id === id))
        ? communityToResourcesConnection
        : []),

      ...(selectedNodeIds.some((id) =>
        goalNodes.some((node) => node.id === id)
      ) &&
      selectedNodeIds.some((id) =>
        carePointsNodes.some((node) => node.id === id)
      )
        ? goalToCarePointsConnection
        : []),
      ...(selectedNodeIds.some((id) =>
        goalNodes.some((node) => node.id === id)
      ) &&
      selectedNodeIds.some((id) => resourceNodes.some((node) => node.id === id))
        ? goalToResourcesConnection
        : []),
      ...(selectedNodeIds.some((id) =>
        carePointsNodes.some((node) => node.id === id)
      ) &&
      selectedNodeIds.some((id) => goalNodes.some((node) => node.id === id))
        ? carePointToGoalsConnection
        : []),
    ]

    setRelationships(filteredRelationships)

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNodes])

  return (
    <ApolloWrapper data={data} loading={loading} error={error}>
      <Stack
        direction={'row'}
        height={'100%'}
        position="relative"
        justifyContent="space-between"
      >
        <GraphSideBar
          selectedNodeInfo={nodeInfo}
          nodes={graphNodes}
          selectedNodes={selectedNodes}
          setSelectedNodeInfo={setSelectedNodeInfo}
          selectedNodeId={nodeId}
          selectedNodeName={nodeName}
          setNodes={setSelectedNodes}
          triggers={NodeTriggers}
        />

        <Box flex={1} width="100%" className={styles.canvas_wrapper}>
          <InteractiveNvlWrapper
            nodes={selectedNodes}
            rels={relationships}
            mouseEventCallbacks={mouseEventCallbacks}
            style={{
              width: '100%',
              height: '90dvh',
            }}
            interactionOptions={{
              selectOnClick: true,
            }}
            nvlOptions={{
              initialZoom: 1.5,
              maxZoom: 5,
              minZoom: 1,
              panX: 0,
              panY: 0,
              renderer: 'canvas',
              minimapContainer: graphControlsRef.current ?? undefined,
            }}
          />
        </Box>

        <GraphControls ref={graphControlsRef} />
      </Stack>
    </ApolloWrapper>
  )
}

export default GraphVisualization
