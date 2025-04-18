'use client'

import { Form, Message, Thinking } from '@/components/chatbot'
import { useChat } from '@/hooks'
import { Box, Text } from '@chakra-ui/react'
import React from 'react'

export default function Chatbot() {
  const { messages, thinking, container, generateResponse } = useChat()

  const thinkingText = `🤔 ${
    process.env.NEXT_PUBLIC_CHATBOT_NAME || 'Chatbot'
  } is thinking...`

  const CHATBOT_NAME = 'Chatbot'
  const CHATBOT_DESCRIPTION = 'A chatbot powered by GraphRAG'

  return (
    <>
      <div
        className="n- flex n- flex-col n- h-screen n-"
        style={{ height: '100vh' }}
      >
        <div className="p-4  bg-blue-800 flex flex-row justify-between">
          <h1 className="text-white">
            <Text as="span" fontWeight="bold">
              {CHATBOT_NAME} -{' '}
            </Text>
            <Text as="span" color="orange.400">
              {CHATBOT_DESCRIPTION}
            </Text>
          </h1>
        </div>

        <Box
          bg="yellow.200"
          color="yellow.800"
          p={4}
          textAlign="center"
          rounded="md"
          shadow="md"
          mb={4}
        >
          <Text fontSize="md" fontWeight="semibold">
            Our chatbot is still being trained and refined to give accurate
            responses and is currently in beta testing stage.
          </Text>
        </Box>

        <div
          ref={container}
          className="
        flex flex-grow flex-col space-y-4 p-3 overflow-y-auto
        scrollbar-thumb-blue scrollbar-thumb-rounded scrollbar-track-blue-lighter scrollbar-w-2 scrolling-touch"
        >
          {messages.map((m, i) => {
            return <Message key={i} message={m} />
          })}

          {thinking && <Thinking />}
        </div>

        <Form
          messages={messages}
          thinking={thinking}
          container={container}
          onSubmit={(m) => generateResponse(m)}
        />

        <div className="flex flex-row justify-between b-slate-200 px-4 pb-4 bg-slate-100 text-xs text-slate-600">
          <div className="animate-pulse">{thinking ? thinkingText : ' '}</div>
          <div>
            Powered by
            <a href="https://neo4j.com" target="_blank" className="font-bold">
              {' '}
              GraphRAG
            </a>
          </div>
        </div>
      </div>
    </>
  )
}
