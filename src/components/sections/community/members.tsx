'use client'
import { GET_ALL_PEOPLE, UPDATE_COMMUNITY_MUTATION } from '@/app/graphql'

import {
  Button,
  EmptyState,
  DialogRoot,
  DialogActionTrigger,
  DialogBody,
  DialogCloseTrigger,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  MultiSelect,
  toaster,
  ConfirmButton,
  CancelButton,
  PersonCard,
  ApolloWrapper,
} from '@/components'
import { Community, Person } from '@/gql/graphql'
import { useMutation, useQuery } from '@apollo/client'
import { DialogBackdrop, Grid, HStack, Spacer, VStack } from '@chakra-ui/react'
import React, { useRef, useState } from 'react'
import { useForm } from 'react-hook-form'

export default function CommunityMembers({
  community,
}: {
  community: Community
}) {
  const [open, setOpen] = useState(false)

  const { data, loading, error } = useQuery(GET_ALL_PEOPLE)
  const [UpdateCommunity] = useMutation(UPDATE_COMMUNITY_MUTATION)
  const [members, setMembers] = useState<Person[]>(community.members)
  const contentRef = useRef<HTMLDivElement>(null)
  const cancelButtonRef = useRef<HTMLButtonElement>(null)

  const valueOptions =
    data?.people.map((person) => ({
      label: person.name,
      value: person.id,
    })) ?? []

  type FormData = {
    members: string[]
  }

  const {
    handleSubmit,
    control,
    formState: { isSubmitting, errors },
  } = useForm<FormData>({
    defaultValues: {
      members: members.map((member) => member.id) ?? [],
    },
  })

  const onSubmit = async (data: FormData) => {
    try {
      // find members to disconnect and connect
      const initialMembers = members.map((member) => member.id)

      const toDisconnect = initialMembers.filter(
        (member) => !data.members.includes(member)
      )
      const toConnect = data.members.filter(
        (member) => !initialMembers.map((p) => p).includes(member)
      )

      const response = await UpdateCommunity({
        variables: {
          id: community.id,
          update: {
            members: [
              {
                connect: [{ where: { node: { id_IN: toConnect } } }],
                disconnect: [{ where: { node: { id_IN: toDisconnect } } }],
              },
            ],
          },
        },
      })

      if (!response.data) {
        throw new Error('No data returned')
      }

      setMembers(
        response.data.updateCommunities.communities[0].members as Person[]
      )
      console.log(response.data.updateCommunities.communities[0].members)
      setOpen(false)
      toaster.success({
        title: 'Updated Members',
        description: `The members of ${community.name} have been updated`,
      })
    } catch (error) {
      console.error(error)
    }
  }

  return (
    <ApolloWrapper data={data} loading={loading} error={error}>
      <VStack bg={'bg'} p={4} borderRadius={'2xl'} boxShadow={'xs'}>
        <DialogRoot
          placement="center"
          open={open}
          onOpenChange={(e) => setOpen(e.open)}
        >
          <DialogBackdrop />
          {/* <DialogTrigger asChild> */}
          <HStack width="100%" justifyContent="space-between">
            <Spacer />
            {members.length > 0 && (
              <Button size="sm" variant="surface" onClick={() => setOpen(true)}>
                Update Members
              </Button>
            )}
          </HStack>
          {/* </DialogTrigger> */}
          <form onSubmit={handleSubmit(onSubmit)}>
            <DialogContent ref={contentRef}>
              <DialogHeader>
                <DialogTitle>{`${community.name}'s Members`}</DialogTitle>
              </DialogHeader>
              <DialogBody>
                <MultiSelect
                  name="members"
                  label="Add some members"
                  control={control}
                  errors={errors}
                  options={valueOptions}
                  portalRef={contentRef}
                  multiple
                />
              </DialogBody>
              <DialogFooter>
                <DialogActionTrigger asChild>
                  <CancelButton ref={cancelButtonRef} />
                </DialogActionTrigger>
                <ConfirmButton
                  loading={isSubmitting}
                  onClick={handleSubmit(onSubmit)}
                />
              </DialogFooter>
              <DialogCloseTrigger />
            </DialogContent>
          </form>
        </DialogRoot>
        {members.length === 0 ? (
          <EmptyState title="No Members" description="Click here to add some">
            <Button variant="surface" onClick={() => setOpen(true)}>
              Add A Member
            </Button>
          </EmptyState>
        ) : (
          <Grid
            key="members"
            templateColumns="repeat(auto-fill, minmax(200px, 1fr))"
            gap={6}
            width="100%"
          >
            {members.map((member) => (
              <PersonCard
                key={member.id}
                id={member.id}
                name={member.name}
                photo={member.photo}
              />
            ))}
          </Grid>
        )}
      </VStack>
    </ApolloWrapper>
  )
}
