import { config } from 'dotenv'
import { BaseChatModel } from 'langchain/chat_models/base'
import { RunnableSequence } from '@langchain/core/runnables'
import { ChatOpenAI } from '@langchain/openai'
import { PromptTemplate } from '@langchain/core/prompts'
import { StringOutputParser } from '@langchain/core/output_parsers'
import initRephraseChain from './rephrase-question.chain'
import { ChatbotResponse } from '../history'

describe('Rephrase Question Chain', () => {
  let llm: BaseChatModel
  let chain: RunnableSequence
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let evalChain: RunnableSequence<any, any>

  beforeAll(async () => {
    config({ path: '.env.local' })

    llm = new ChatOpenAI({
      openAIApiKey: process.env.OPENAI_API_KEY,
      modelName: 'gpt-3.5-turbo',
      temperature: 0,
      configuration: {
        baseURL: process.env.OPENAI_API_BASE,
      },
    })

    chain = await initRephraseChain(llm)

    evalChain = RunnableSequence.from([
      PromptTemplate.fromTemplate(`
        Is the rephrased version a complete standalone question that can be answered by an LLM?

        Original: {input}
        Rephrased: {response}

        If the question is a suitable standalone question, respond "yes".
        If not, respond with "no".
        If the rephrased question asks for more information, respond with "missing".
      `),
      llm,
      new StringOutputParser(),
    ])
  })

  describe('Rephrasing Questions', () => {
    it('should handle a question with no history', async () => {
      const input = 'Who is interested in anime in my network?'

      const response = await chain.invoke({
        input,
        history: [],
      })

      const evaluation = await evalChain.invoke({ input, response })
      expect(`${evaluation.toLowerCase()} - ${response}`).toContain('yes')
    })

    it('should rephrase a question based on its history', async () => {
      const history = [
        {
          input: 'Can you recommend me a person interested in anime?',
          output: 'Sure, I recommend Lara',
        },
      ]
      const input = 'What is her avatar?'
      const response = await chain.invoke({
        input,
        history,
      })

      expect(response).toContain('Lara')

      const evaluation = await evalChain.invoke({ input, response })
      expect(`${evaluation.toLowerCase()} - ${response}`).toContain('yes')
    })

    it('should ask for clarification if a question does not make sense', async () => {
      const input = 'What about last week?'
      const history: ChatbotResponse[] = []

      const response = await chain.invoke({
        input,
        history,
      })

      const evaluation = await evalChain.invoke({ input, response })
      expect(`${evaluation.toLowerCase()} - ${response}`).toContain('provide')
    })
  })
})
