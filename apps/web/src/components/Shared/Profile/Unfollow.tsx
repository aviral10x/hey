import type { Profile, UnfollowRequest } from '@hey/lens';
import type { FC } from 'react';

import { LensHub } from '@hey/abis';
import { Errors } from '@hey/data';
import { LENSHUB_PROXY } from '@hey/data/constants';
import { PROFILE } from '@hey/data/tracking';
import {
  useBroadcastOnchainMutation,
  useCreateUnfollowTypedDataMutation,
  useUnfollowMutation
} from '@hey/lens';
import { useApolloClient } from '@hey/lens/apollo';
import checkDispatcherPermissions from '@hey/lib/checkDispatcherPermissions';
import getSignature from '@hey/lib/getSignature';
import { Button } from '@hey/ui';
import errorToast from '@lib/errorToast';
import { Leafwatch } from '@lib/leafwatch';
import { useRouter } from 'next/router';
import { useState } from 'react';
import toast from 'react-hot-toast';
import useHandleWrongNetwork from 'src/hooks/useHandleWrongNetwork';
import { useGlobalModalStateStore } from 'src/store/non-persisted/useGlobalModalStateStore';
import { useNonceStore } from 'src/store/non-persisted/useNonceStore';
import { useProfileRestriction } from 'src/store/non-persisted/useProfileRestriction';
import useProfileStore from 'src/store/persisted/useProfileStore';
import { useSignTypedData, useWriteContract } from 'wagmi';

interface UnfollowProps {
  profile: Profile;
  small?: boolean;
}

const Unfollow: FC<UnfollowProps> = ({ profile, small = false }) => {
  const { pathname } = useRouter();
  const currentProfile = useProfileStore((state) => state.currentProfile);
  const { isSuspended } = useProfileRestriction();
  const lensHubOnchainSigNonce = useNonceStore(
    (state) => state.lensHubOnchainSigNonce
  );
  const setLensHubOnchainSigNonce = useNonceStore(
    (state) => state.setLensHubOnchainSigNonce
  );
  const setShowAuthModal = useGlobalModalStateStore(
    (state) => state.setShowAuthModal
  );
  const [isLoading, setIsLoading] = useState(false);
  const handleWrongNetwork = useHandleWrongNetwork();
  const { cache } = useApolloClient();

  const { canBroadcast, canUseLensManager } =
    checkDispatcherPermissions(currentProfile);

  const updateCache = () => {
    cache.modify({
      fields: {
        isFollowedByMe: (existingValue) => {
          return { ...existingValue, value: false };
        }
      },
      id: cache.identify(profile.operations)
    });
  };

  const onCompleted = (
    __typename?: 'LensProfileManagerRelayError' | 'RelayError' | 'RelaySuccess'
  ) => {
    if (
      __typename === 'RelayError' ||
      __typename === 'LensProfileManagerRelayError'
    ) {
      return;
    }

    updateCache();
    setIsLoading(false);
    toast.success('Unfollowed successfully!');
    Leafwatch.track(PROFILE.UNFOLLOW, { path: pathname, target: profile?.id });
  };

  const onError = (error: any) => {
    setIsLoading(false);
    errorToast(error);
  };

  const { signTypedDataAsync } = useSignTypedData({ mutation: { onError } });
  const { writeContractAsync } = useWriteContract({
    mutation: { onError, onSuccess: () => onCompleted() }
  });

  const write = async ({ args }: { args: any[] }) => {
    return await writeContractAsync({
      abi: LensHub,
      address: LENSHUB_PROXY,
      args,
      functionName: 'unfollow'
    });
  };

  const [broadcastOnchain] = useBroadcastOnchainMutation({
    onCompleted: ({ broadcastOnchain }) =>
      onCompleted(broadcastOnchain.__typename)
  });
  const [createUnfollowTypedData] = useCreateUnfollowTypedDataMutation({
    onCompleted: async ({ createUnfollowTypedData }) => {
      const { id, typedData } = createUnfollowTypedData;
      const { idsOfProfilesToUnfollow, unfollowerProfileId } = typedData.value;
      const args = [unfollowerProfileId, idsOfProfilesToUnfollow];
      await handleWrongNetwork();

      if (canBroadcast) {
        const signature = await signTypedDataAsync(getSignature(typedData));
        const { data } = await broadcastOnchain({
          variables: { request: { id, signature } }
        });
        if (data?.broadcastOnchain.__typename === 'RelayError') {
          return await write({ args });
        }
        setLensHubOnchainSigNonce(lensHubOnchainSigNonce + 1);

        return;
      }

      return await write({ args });
    },
    onError
  });

  const [unfollow] = useUnfollowMutation({
    onCompleted: ({ unfollow }) => onCompleted(unfollow.__typename),
    onError
  });

  const unfollowViaLensManager = async (request: UnfollowRequest) => {
    const { data } = await unfollow({ variables: { request } });
    if (data?.unfollow?.__typename === 'LensProfileManagerRelayError') {
      return await createUnfollowTypedData({ variables: { request } });
    }
  };

  const createUnfollow = async () => {
    if (!currentProfile) {
      setShowAuthModal(true);
      return;
    }

    if (isSuspended) {
      return toast.error(Errors.Suspended);
    }

    try {
      setIsLoading(true);
      const request: UnfollowRequest = { unfollow: [profile?.id] };

      if (canUseLensManager) {
        return await unfollowViaLensManager(request);
      }

      return await createUnfollowTypedData({
        variables: {
          options: { overrideSigNonce: lensHubOnchainSigNonce },
          request
        }
      });
    } catch (error) {
      onError(error);
    }
  };

  return (
    <Button
      aria-label="Following"
      disabled={isLoading}
      onClick={createUnfollow}
      size={small ? 'sm' : 'md'}
    >
      Following
    </Button>
  );
};

export default Unfollow;
