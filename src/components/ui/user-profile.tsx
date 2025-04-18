import { Box, HStack, Link, Stack, Text, VStack } from '@chakra-ui/react'
import { Avatar } from './avatar'
import { GenericTabs } from './generic-tabs'
import { Person } from '@/gql/graphql'
import { EntityEnum, TRIGGERS, TriggerValues } from '@/constants'
import { DeleteButton, EditButton } from './buttons'

interface UserProfileProps {
  user: Person
  tabTriggers: TriggerValues[]
  tabContent: React.ReactNode[]
}

export function PersonProfile({
  user,
  tabTriggers,
  tabContent,
}: UserProfileProps) {
  return (
    <VStack
      border={{ base: 'none', lg: '2px solid #E19E48' }}
      borderRadius={{ base: 0, lg: '2xl' }}
      position={{ lg: 'absolute' }}
      top={{ lg: '40px' }}
      left={{ lg: '70px' }}
      zIndex={1}
      maxWidth={'380px'}
      width={'100%'}
      mb={{ lg: '40px' }}
      paddingY={{ md: '45px' }}
      px={{ lg: 8 }}
      background={{ base: 'inherit', lg: 'gray.contrast' }}
    >
      <>
        <Stack align={'center'} justify={'center'}>
          <Avatar
            name={user?.name}
            src={user.photo ?? undefined}
            width={'200px'}
            height={'200px'}
            border={'3px solid white'}
          />
          <Text>Hi, I'm</Text>
          <Text fontSize={'xl'} fontWeight={'bold'} py={0}>
            {user?.name}
          </Text>
          {user?.email && <Text>{user?.email}</Text>}

          <HStack justifyContent={'center'} gap={5}>
            <Link asChild href={'/update/person/' + user.id}>
              <EditButton
                display={{ lg: 'none' }}
                colorPalette={'person'}
                text={`Edit`}
                size="xl"
              />
            </Link>
            <Box display={{ base: 'block', lg: 'none' }}>
              <DeleteButton
                entityId={user.id}
                entityType={EntityEnum.Person}
                entityName={user.name}
              />
            </Box>
          </HStack>
        </Stack>

        <GenericTabs
          entityId={user.id}
          entityType={EntityEnum.Person}
          entityName={user.name}
          removeTriggers
          triggers={tabTriggers}
          content={tabContent}
        />
      </>
    </VStack>
  )
}
