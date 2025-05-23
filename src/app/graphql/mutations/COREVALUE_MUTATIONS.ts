import { graphql } from '@/gql'

export const CREATE_COREVALUE_MUTATION = graphql(`
  mutation CreateCoreValues($input: [CoreValueCreateInput!]!) {
    createCoreValues(input: $input) {
      coreValues {
        id
        name
        alignmentChallenges
        alignmentExamples
        description
        why
        createdAt
      }
    }
  }
`)

export const UPDATE_COREVALUE_MUTATION = graphql(`
  mutation UpdateCoreValue($id: ID!, $update: CoreValueUpdateInput!) {
    updateCoreValues(where: { id_EQ: $id }, update: $update) {
      coreValues {
        id
        name
        alignmentChallenges
        alignmentExamples
        description
        why
        createdAt
        people {
          id
          name
          photo
        }
        communities {
          id
          name
          description
        }
        goals {
          id
          name
          description
          status
        }
      }
    }
  }
`)

export const DELETE_COREVALUE_MUTATION = graphql(`
  mutation DeleteCoreValue($id: ID!) {
    deleteCoreValues(where: { id_EQ: $id }) {
      nodesDeleted
    }
  }
`)
