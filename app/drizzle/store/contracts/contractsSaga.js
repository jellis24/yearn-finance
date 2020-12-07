import { END, eventChannel } from 'redux-saga';
import { call, put, select, take, takeEvery } from 'redux-saga/effects';
import erc20Abi from 'abi/erc20.json';
import { selectAccount } from 'containers/ConnectionProvider/selectors';
import { addContracts } from 'containers/DrizzleProvider/actions';
import * as EventActions from './constants';

/*
 * Events
 */

export function createContractEventChannel({
  contract,
  eventName,
  eventOptions,
}) {
  const name = contract.contractName;

  return eventChannel(emit => {
    const eventListener = contract.events[eventName](eventOptions)
      .on('data', event => {
        emit({ type: EventActions.EVENT_FIRED, name, event });
      })
      .on('changed', event => {
        emit({ type: EventActions.EVENT_CHANGED, name, event });
      })
      .on('error', error => {
        emit({ type: EventActions.EVENT_ERROR, name, error });
        emit(END);
      });

    const unsubscribe = () => {
      eventListener.removeListener(eventName);
    };

    return unsubscribe;
  });
}

function* callListenForContractEvent({ contract, eventName, eventOptions }) {
  const contractEventChannel = yield call(createContractEventChannel, {
    contract,
    eventName,
    eventOptions,
  });

  while (true) {
    const event = yield take(contractEventChannel);
    yield put(event);
  }
}

/*
 * Send and Cache
 */

function createTxChannel({
  txObject,
  stackId,
  sendArgs = {},
  contractName,
  stackTempKey,
}) {
  let persistTxHash;

  return eventChannel(emit => {
    const txPromiEvent = txObject
      .send(sendArgs)
      .on('transactionHash', txHash => {
        persistTxHash = txHash;

        emit({ type: 'TX_BROADCASTED', txHash, stackId });
        emit({ type: 'CONTRACT_SYNC_IND', contractName });
      })
      .on('confirmation', (confirmationNumber, receipt) => {
        emit({
          type: 'TX_CONFIRMAITON',
          confirmationReceipt: receipt,
          txHash: persistTxHash,
        });
      })
      .on('receipt', receipt => {
        emit({
          type: 'TX_SUCCESSFUL',
          receipt,
          txHash: persistTxHash,
        });
        emit(END);
      })
      .on('error', (error, receipt) => {
        console.error(error);
        console.error(receipt);

        emit({ type: 'TX_ERROR', error, stackTempKey });
        emit(END);
      });

    const unsubscribe = () => {
      txPromiEvent.off();
    };

    return unsubscribe;
  });
}

function* callSendContractTx({
  contract,
  fnName,
  fnIndex,
  args,
  stackId,
  stackTempKey,
}) {
  // Check for type of object and properties indicative of call/send options.
  if (args.length) {
    const finalArg = args.length > 1 ? args[args.length - 1] : args[0];
    var sendArgs = {};
    var finalArgTest = false;

    if (typeof finalArg === 'object') {
      var finalArgTest = yield call(isSendOrCallOptions, finalArg);
    }

    if (finalArgTest) {
      sendArgs = finalArg;

      args.length > 1 ? delete args[args.length - 1] : delete args[0];
      args.length -= 1;
    }
  }

  // Get name to mark as desynchronized on tx creation
  const { contractName } = contract;

  // Create the transaction object and execute the tx.
  const txObject = yield call(contract.methods[fnName], ...args);
  const txChannel = yield call(createTxChannel, {
    txObject,
    stackId,
    sendArgs,
    contractName,
    stackTempKey,
  });

  try {
    while (true) {
      const event = yield take(txChannel);
      yield put(event);
    }
  } finally {
    txChannel.close();
  }
}

/*
 * Call and Cache
 */

function* callCallContractFn({
  contract,
  fnName,
  fnIndex,
  args,
  argsHash,
  sync = false,
}) {
  // keeping for pre-v1.1.5 compatibility with CALL_CONTRACT_FN event.
  if (sync) {
    return;
  }

  // Check for type of object and properties indicative of call/send options.
  if (args.length) {
    const finalArg = args.length > 1 ? args[args.length - 1] : args[0];
    var callArgs = {};
    var finalArgTest = false;

    if (typeof finalArg === 'object') {
      var finalArgTest = yield call(isSendOrCallOptions, finalArg);
    }

    if (finalArgTest) {
      callArgs = finalArg;

      args.length > 1 ? delete args[args.length - 1] : delete args[0];
      args.length -= 1;
    }
  }

  // Create the transaction object and execute the call.
  const txObject = yield call(contract.methods[fnName], ...args);

  try {
    const callResult = yield call(txObject.call, callArgs);

    const { group, contractName } = contract;
    const dispatchArgs = {
      name: contractName,
      variable: contract.abi[fnIndex].name,
      argsHash,
      args,
      value: callResult,
      fnIndex,
      group,
    };

    yield put({ type: 'GOT_CONTRACT_VAR', ...dispatchArgs });
  } catch (error) {
    console.error(error);

    const errorArgs = {
      name: contract.contractName,
      variable: contract.abi[fnIndex].name,
      argsHash,
      args,
      error,
      fnIndex,
    };

    yield put({ type: 'ERROR_CONTRACT_VAR', ...errorArgs });
  }
}

/*
 * Sync Contract
 */

function* callSyncContract(action) {
  // Get contract state from store
  const { contract } = action;
  const { contractName } = contract;

  const contractsState = yield select(getContractsState);
  const contractFnsState = Object.assign({}, contractsState[contractName]);

  // Remove unnecessary keys
  delete contractFnsState.initialized;
  delete contractFnsState.synced;
  delete contractFnsState.events;
  delete contractFnsState.group;
  delete contractFnsState.metadata;
  delete contractFnsState.readMethods;
  delete contractFnsState.writeMethods;

  // Iterate over functions and hashes
  for (const fnName in contractFnsState) {
    for (const argsHash in contractFnsState[fnName]) {
      const { fnIndex } = contractFnsState[fnName][argsHash];
      const { args } = contractFnsState[fnName][argsHash];

      // Pull args and call fn for each given function
      // keeping for pre-v1.1.5 compatibility with CALL_CONTRACT_FN event.
      yield put({
        type: 'CALL_CONTRACT_FN',
        contract,
        fnName,
        fnIndex,
        args,
        argsHash,
        sync: true,
      });
      yield call(callCallContractFn, {
        contract,
        fnName,
        fnIndex,
        args,
        argsHash,
      });
    }
  }
  // When complete, dispatch CONTRACT_SYNCED
  yield put({ type: 'CONTRACT_SYNCED', contractName });
}

const getContractsState = state => state.contracts;

function isSendOrCallOptions(options) {
  if ('from' in options) return true;
  if ('gas' in options) return true;
  if ('gasPrice' in options) return true;
  if ('value' in options) return true;

  return false;
}

function* executeBatchCall(action) {
  const { request, batchCall } = action;
  const requestNotEmpty = _.size(request);
  if (requestNotEmpty) {
    const response = yield batchCall.execute(request);
    yield put({ type: 'BATCH_CALL_RESPONSE', payload: response });
  }
}

function* processResponse(action) {
  const { payload, drizzle } = action;
  const account = yield select(selectAccount());
  const responseItemsWithTokens = _.filter(payload, item => item.token);
  const findNewTokens = (acc, responseItem) => {
    const { token } = responseItem;
    const tokenContract = drizzle.findContractByAddress(token.toLowerCase());
    if (!tokenContract) {
      acc.push(token);
    }
    return acc;
  };
  const newTokenAddresses = _.reduce(
    responseItemsWithTokens,
    findNewTokens,
    [],
  );

  const foundNewTokens = _.size(newTokenAddresses);
  if (foundNewTokens) {
    const tokenSubscriptions = [
      {
        namespace: 'tokens',
        abi: erc20Abi,
        allReadMethods: false,
        syncOnce: true, // Additional syncs will be performed by watching logs
        addresses: newTokenAddresses,
        readMethods: [
          {
            name: 'balanceOf',
            args: [account],
          },
        ],
      },
    ];
    yield put(addContracts(tokenSubscriptions));
  }
}

function* contractsSaga() {
  yield takeEvery('BATCH_CALL_REQUEST', executeBatchCall);
  yield takeEvery('BATCH_CALL_RESPONSE', processResponse);
  yield takeEvery('SEND_CONTRACT_TX', callSendContractTx);
  yield takeEvery('CALL_CONTRACT_FN', callCallContractFn);
  yield takeEvery('CONTRACT_SYNCING', callSyncContract);
  yield takeEvery('LISTEN_FOR_EVENT', callListenForContractEvent);
}

export default contractsSaga;
