import { EntityType } from '@/types'
import { Box, Flex, Heading, Text, VStack } from '@chakra-ui/react'

export function EntityPageHeader({ entity }: { entity: EntityType }) {
  let parsedEntity = entity.toLowerCase()
  if (entity === 'CoreValue') {
    parsedEntity = 'core value'
  }

  if (entity === 'CarePoint') {
    parsedEntity = 'care point'
  }

  return (
    <VStack display={{ base: 'none', lg: 'flex' }} mx={-8}>
      <Flex
        width={'100%'}
        height={'210px'}
        bgColor={`${entity.toLowerCase()}.subtle`}
        borderTopRadius={16}
        justifyContent="flex-end"
        alignItems="center"
        px={10}
      >
        <Heading
          fontSize="100px"
          fontWeight="black"
          color={`${entity.toLowerCase()}.emphasized`}
        >
          {parsedEntity}
        </Heading>
      </Flex>
    </VStack>
  )
}
