/**
 * Objectives:
 * 1. Subscribe to a peers' EventHub and check if it is from the correct channel (Done)
 * 2. Wait for BlockCreation events (Done)
 * 3. Parse transactions
 * 4. Find the set of Accounts that have been changed
 * 5. Sum the transactions directed to each account
 * 6. Send the sum a designated address
 * */

import * as Path from "path";
import * as fs from "fs-extra";
// import * as Express from "express";
import * as FabricClient from "fabric-client/lib/Client";
import * as EventHub from "fabric-client/lib/EventHub";
import * as Request from "request";
import * as DecodeTransactions from "./decodeTransactions";

// const app = Express();
// const port = 3000;
const message = "Starting block-edge";
let networkConfiguration = undefined;
try {
    networkConfiguration = JSON.parse(fs.readFileSync(Path.join(Path.sep, "block-edge", "network", "configuration.json")));
}
catch (e) {
    console.error("Unable to load network configuration", e);
}

if (!process.env.PARENT) {
    console.error("No parent-cluster found. Exiting..");
    process.exit(1);
}

let registrationNumber = undefined;
let eventHub: EventHub = undefined;
// app.get('/', (request, response) => {
//     response.send('Ready for requests!');
// });
//
// app.get('/start', (request, response) => {
//     response.send(message);
// });
//
// app.get('/stop', (request, response) => {
//     response.send(message);
//     stop();
// });

(async () => {
    await start();
})();

async function start() {
    console.debug(message);

    const organization = firstPeerOrganization();
    const client = new FabricClient();

    try {
        await createStateStore(client, organization);
        await createAdminUser(client, organization);
    }
    catch (e) {
        console.error("Unable to create user", organization.user.name, "for organization", organization.name);
    }
    subscribeToBlockEvent(client, organization['peer0']);
}

async function createStateStore(client, organization) {
    const store = await FabricClient.newDefaultKeyValueStore({
        path: Path.join(Path.sep, "block-edge", "tmp", organization.name)
    });
    client.setStateStore(store);
}

function createAdminUser(client, organization) {
    const privateKeyPEM = fs.readFileSync(organization.user.key);
    const certPEM = fs.readFileSync(organization.user.cert);
    return client.createUser({
        username: 'peer' + organization.name + 'Admin',
        mspid: organization.mspid,
        cryptoContent: {
            privateKeyPEM: privateKeyPEM.toString(),
            signedCertPEM: certPEM.toString()
        }
    });
}

function firstPeerOrganization(): any {
    if (networkConfiguration) {
        for (let organizationName in networkConfiguration) {
            if (networkConfiguration.hasOwnProperty(organizationName)) {
                const organization = networkConfiguration[organizationName];
                for (let key in organization) {
                    if (organization.hasOwnProperty(key) && key.indexOf('peer0') > -1) {
                        return organization;
                    }
                }
            }
        }
    }
}

const maxRetries = 8;
const retries = 0;

function subscribeToBlockEvent(client, peer) {
    try {
        console.debug("Subscribing to BlockEvents");
        eventHub = new EventHub(client);
        let peerCertificateData = fs.readFileSync(peer.tls_cacerts);
        eventHub.setPeerAddr(
            peer.events,
            {
                pem: Buffer.from(peerCertificateData).toString(),
                'ssl-target-name-override': peer["server-hostname"]
            }
        );
        eventHub.connect();
        registrationNumber = eventHub.registerBlockEvent((block) => {
            handleBlock(block);
        });
    }
    catch (e) {
        console.error("Unable to register for block-events", e);
        const retryAfterMillis = 10000;
        console.log("Retrying after", retryAfterMillis + "ms");
        if (retries <= maxRetries) {
            setTimeout(() => {
                subscribeToBlockEvent(client, peer);
            }, retryAfterMillis);
        }
    }
}


/**
 * Transaction[]
 *
 * @param block
 */
function handleBlock(block) {
    console.debug("Received a block");
    const channelName = "kubechain";
    const transactions = block.data.data;

    const decodedTransactions = DecodeTransactions.decodeTransactions(transactions, channelName);

    const chaincodeInvocationArgumentTransactions = chaincodeInvocationsArguments(decodedTransactions);
    console.warn(chaincodeInvocationArgumentTransactions);

    if (chaincodeInvocationArgumentTransactions && chaincodeInvocationArgumentTransactions.length > 0 && chaincodeInvocationArgumentTransactions[0]) {
        Request.post(`http://${process.env.PARENT}/block`,
            {
                json: {
                    transactions: chaincodeInvocationArgumentTransactions
                }
            },
            (error, httpResponse, body) => {
                if (error) {
                    console.error("Error during transaction relay", error);
                }
                else {
                    console.debug("Sent block");
                }
            })
    }
}

function chaincodeInvocationsArguments(transactions): string[] {
    return transactions.map((transaction) => {
        const ledgerActions = transaction.payload.data.actions;
        if (ledgerActions) {
            return ledgerActions.map((ledgerAction) => {
                const chaincodeInvocationSpec = ledgerAction.payload.chaincode_proposal_payload.input;
                return chaincodeInvocationArguments(chaincodeInvocationSpec);
            });
        }
    });
}

function chaincodeInvocationArguments(chaincodeInvocationSpec) {
    return chaincodeInvocationSpec.chaincode_spec.input.args.map((argument) => {
        return Buffer.from(argument.buffer).toString('utf-8').substring(argument.offset, argument.limit);
    })
}

//
// function stop() {
//     if (registrationNumber && eventHub) {
//         eventHub.unregisterBlockEvent(registrationNumber);
//     }
// }

// app.listen(port, (err: string) => {
//     if (err) {
//         return console.log('Error while listening to :', err)-
//     }
//
//     console.log(`server is listening on ${port}`)
// });
