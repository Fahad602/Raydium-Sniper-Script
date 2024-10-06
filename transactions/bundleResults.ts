import { Connection, VersionedTransaction } from '@solana/web3.js';
import { SearcherClient } from 'jito-ts/dist/sdk/block-engine/searcher';
import { Bundle } from 'jito-ts/dist/sdk/block-engine/types';

export async function sendBundle(
    search: SearcherClient,
    bund: Bundle,
) {
    try {
        return await search.sendBundle(bund);
    } catch (e) {
        console.log('error sending bundle:\n');
        return null
    }
}

export const onBundleResult = (
    c: SearcherClient,
    txSig: string,
    targetBundleId: string,
    connection: Connection): Promise<[number, any, any]> => {


    return new Promise((resolve) => {

        let state = 0;
        let isResolved = false;

        //tx signature listener plz save my sanity
        let sigSubId = connection.onSignature(txSig, (res) => {
            if (isResolved) {
                connection.removeSignatureListener(sigSubId);
                return;
            }
            if (!res.err) {
                isResolved = true
                console.log('TX Confirmed', txSig);
                resolve([1, () => { }, 0]);
            }
        }, 'confirmed');


        //SUPER FUCKING BUGGY LISTENER HOLY FUCK I HATE THIS SOO MCUH
        const listener = c.onBundleResult(
            //@ts-ignore
            (result) => {
                if (isResolved) return state;


                const bundleId = result.bundleId;
                const isAccepted = result.accepted;
                const isRejected = result.rejected;

                if (targetBundleId != bundleId) { return }

                //if (bundleId == targetBundleId)

                    if (isResolved == false) {

                        if (isAccepted) {

                            console.log(
                                    ("bundle accepted, ID:"),
                                    (bundleId),
                                    " Slot: ",
                                    (result?.accepted?.slot)
                                );
                            state += 1;
                            isResolved = true;
                            resolve([state, listener, 0]); // Resolve with 'first' when a bundle is accepted
                            return
                        }

                        if (isRejected) {
                            console.log('Failed to send Bundle.');
                            isResolved = true;

                            if (isRejected.simulationFailure) {
                                if (isRejected.simulationFailure.msg?.toLowerCase().includes('partially') || isRejected.simulationFailure.msg?.toLowerCase().includes('been processed')) {
                                    resolve([1, listener, 0]);
                                    return
                                }
                                const details = isRejected.simulationFailure.msg ?? '';
                                console.log(details);
                                //addBundleErrorEntry('Simulation Failure', details, { bundleId: bundleId })
                            }

                            if (isRejected.internalError) {
                                if (isRejected.internalError.msg?.toLowerCase().includes('partially')) {
                                    resolve([1, listener, 0]);
                                    return
                                }
                                const details = isRejected.internalError.msg ?? '';
                                console.log(details);
                                //addBundleErrorEntry('Internal Error', details, { bundleId: bundleId })
                            }

                            if (isRejected.stateAuctionBidRejected) {
                                if (isRejected.stateAuctionBidRejected.msg?.toLowerCase().includes('partially')) {
                                    resolve([1, listener, 0]);
                                    return
                                }
                                const details = isRejected.stateAuctionBidRejected.msg ?? '';
                                console.log(details);
                                //addBundleErrorEntry('State Auction Bid Rejected', details, { bundleId: bundleId })
                            }

                            if (isRejected.droppedBundle) {
                                if (isRejected.droppedBundle.msg?.toLowerCase().includes('partially') || isRejected.droppedBundle.msg?.toLowerCase().includes('been processed')) {
                                    resolve([1, listener, 0]);
                                    return
                                }
                                const details = isRejected.droppedBundle.msg ?? '';
                                console.log(details);
                                //addBundleErrorEntry('Dropped Bundle', details, { bundleId: bundleId })
                            }

                            if (isRejected.winningBatchBidRejected) {
                                if (isRejected.winningBatchBidRejected.msg?.toLowerCase().includes('partially')) {
                                    resolve([1, listener, 0]);
                                    return
                                }
                                const details = isRejected.winningBatchBidRejected.msg ?? '';
                                console.log(details);
                                //addBundleErrorEntry('Winning Batch Bid Rejected', details, { bundleId: bundleId })
                            }
                            resolve([state, listener, 0]);
                        }
                    }
            },
            (e) => {
                //resolve([state, listener]);
                //console.error(chalk.red(e));
                console.log('error in bundle sub', e);
                resolve([state, listener, 0]);
            }
        );

        setTimeout(() => {
            resolve([state, listener, 1]);
            isResolved = true
        }, 35000);
    });
};