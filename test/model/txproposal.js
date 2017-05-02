'use strict';

var _ = require('lodash');
var chai = require('chai');
var sinon = require('sinon');
var should = chai.should();
var TxProposal = require('../../lib/model/txproposal');
var Bitcore = require('bitcore-lib');

describe('TxProposal', function() {
  describe('#create', function() {
    it('should create a TxProposal', function() {
      var txp = TxProposal.create(testData['2-of-2'].creationArgs);
      should.exist(txp);
      txp.outputs.length.should.equal(2);
      txp.amount.should.equal(30000000);
      txp.network.should.equal('livenet');
    });
  });

  describe('#fromObj', function() {
    it('should copy a TxProposal', function() {
      var txp = TxProposal.fromObj(testData['2-of-2'].txProposal);
      should.exist(txp);
      txp.amount.should.equal(30000000);
    });
  });

  describe('#getBitcoreTx', function() {
    it('should create a valid bitcore TX', function() {
      var txp = TxProposal.fromObj(testData['2-of-2'].txProposal);
      var t = txp.getBitcoreTx();
      should.exist(t);
    });
    it('should order outputs as specified by outputOrder', function() {
      var txp = TxProposal.fromObj(testData['2-of-2'].txProposal);

      txp.outputOrder = [0, 1, 2];
      var t = txp.getBitcoreTx();
      t.getChangeOutput().should.deep.equal(t.outputs[2]);

      txp.outputOrder = [2, 0, 1];
      var t = txp.getBitcoreTx();
      t.getChangeOutput().should.deep.equal(t.outputs[0]);
    });
  });

  describe('#getTotalAmount', function() {
    it('should compute total amount', function() {
      var x = TxProposal.fromObj(testData['2-of-2'].txProposal);
      var total = x.getTotalAmount();
      total.should.equal(x.amount);
    });
  });

  describe('#getEstimatedSize', function() {
    it('should return estimated size in bytes', function() {
      var x = TxProposal.fromObj(testData['2-of-2'].txProposal);
      x.getEstimatedSize().should.equal(396);
    });
  });

  describe('#sign', function() {
    it('should sign 2-2', function() {
      var txp = TxProposal.fromObj(testData['2-of-2'].txProposal);
      txp.sign('1', testData['2-of-2'].signatures, testData['2-of-2'].xpub);
      txp.isAccepted().should.equal(false);
      txp.isRejected().should.equal(false);
      txp.sign('2', testData['2-of-2'].signatures, testData['2-of-2'].xpub);
      txp.isAccepted().should.equal(true);
      txp.isRejected().should.equal(false);
    });
  });

  describe('#getRawTx', function() {
    it.only('should generate correct raw transaction for signed 1-1', function() {
      var txp = TxProposal.fromObj(testData['1-of-1'].txProposal);
      txp.sign('1', testData['1-of-1'].signatures, testData['1-of-1'].xpub);
      txp.getRawTx().should.equal(testData['1-of-1'].rawTx);
    });
    it('should generate correct raw transaction for signed 2-2', function() {
      var txp = TxProposal.fromObj(testData['2-of-2'].txProposal);
      txp.sign('1', testData['2-of-2'].signatures, testData['2-of-2'].xpub);
      txp.getRawTx().should.equal(testData['2-of-2'].rawTx);
    });
  });

  describe('#reject', function() {
    it('should reject 2-2', function() {
      var txp = TxProposal.fromObj(testData['2-of-2'].txProposal);
      txp.reject('1');
      txp.isAccepted().should.equal(false);
      txp.isRejected().should.equal(true);
    });
  });

  describe('#reject & #sign', function() {
    it('should finally reject', function() {
      var txp = TxProposal.fromObj(testData['2-of-2'].txProposal);
      txp.sign('1', testData['2-of-2'].signatures);
      txp.isAccepted().should.equal(false);
      txp.isRejected().should.equal(false);
      txp.reject('2');
      txp.isAccepted().should.equal(false);
      txp.isRejected().should.equal(true);
    });
  });

});

var testData = {
  '1-of-1': {
    xpriv: 'xprv9zWRZ7CXrC4z9xA9RRBFXohmPKbyCajWaCNTHPtwNeJwTnysHG5QK7WMqpNLVtvqGxts7WNcNtqBLfdaFdCGknDPXjLKt2E2BUrPaFDqrLh',
    xpub: 'xpub6DVmxcjRgZdHNSEcXSiFtweVwMSTc3TMwRJ45nJYvyqvLbK1poPerupqh87rSoz27wvckb1CKnGZoLmLXSZyNGZtVd7neqSvdwJL6fceQpe',
    signatures: ['30440220515f87bf7538aba97a8b45f1637ee6fc4ba542c9f1d013a5b1f47517451f237802207317bfc077a7916eed7bad651a89fb5426350123e3a3820a66ceb78341cbdd5d',
      '3045022100c16c44f309727cde583332af92194f1565aa43fae8e4d59b2a3dd3545ee0de5802201f1acd48a057a06eaea413aad3f342225c7243e1623e194e6face53c88681742'
    ],
    rawTx: '0100000002c65819fc97aa0f9a1199e6364f4e5758b2fb322d0f6ed087314f491122762a63030000006a4730440220515f87bf7538aba97a8b45f1637ee6fc4ba542c9f1d013a5b1f47517451f237802207317bfc077a7916eed7bad651a89fb5426350123e3a3820a66ceb78341cbdd5d012103e00bb0cb0fdf50489df10dbeb0004c5262f44d1cfafaf340772edf9aa54c522fffffffff3b784f20b5a97f29fdd5237b614ae697f98d306f7d80ab24d978fed218da3a07040000006b483045022100c16c44f309727cde583332af92194f1565aa43fae8e4d59b2a3dd3545ee0de5802201f1acd48a057a06eaea413aad3f342225c7243e1623e194e6face53c88681742012103e00bb0cb0fdf50489df10dbeb0004c5262f44d1cfafaf340772edf9aa54c522fffffffff0280b2e60e000000001976a91451224bca38efcaa31d5340917c3f3f713b8b20e488ac44e1fa02000000001976a9149edd2399faccf4e57df08bef78962fa0228741cf88ac00000000',
    creationArgs: {
      outputs: [{
        toAddress: '18PzpUFkFZE8zKWUPvfykkTxmB9oMR8qP7',
        amount: 2.5e8,
      }],
      feePerKb: 100e2,
    },
    txProposal: {
      version: 3,
      createdOn: 1493743924,
      id: '532695ad-5b33-4966-895f-9c2fb230bfae',
      walletId: '8fcd7dcc-08e3-4e49-a55a-34122e4c6df0',
      creatorId: '626452e5e0e35df4d9ae4d3e60653c9ae9a814f00c84dc40f5887069b18e2110',
      network: 'livenet',
      outputs: [{
        amount: 250000000,
        toAddress: '18PzpUFkFZE8zKWUPvfykkTxmB9oMR8qP7'
      }],
      amount: 250000000,
      message: undefined,
      payProUrl: undefined,
      changeAddress: {
        version: '1.0.0',
        createdOn: 1493743924,
        address: '1FUzgKcyPJsYwDLUEVJYeE2N3KVaoxTjGS',
        walletId: '8fcd7dcc-08e3-4e49-a55a-34122e4c6df0',
        isChange: true,
        path: 'm/1/0',
        publicKeys: ['02129acdcc600694b3ce55a2d05244186e806174eb0bafde20e5a6395ded647857'],
        network: 'livenet',
        type: 'P2PKH',
      },
      inputs: [{
        txid: '632a762211494f3187d06e0f2d32fbb258574e4f36e699119a0faa97fc1958c6',
        vout: 3,
        address: '1L3z9LPd861FWQhf3vDn89Fnc9dkdBo2CG',
        scriptPubKey: '76a914d0faec47bebd22b7168a6298c3b4d3d7dc84fe2088ac',
        satoshis: 200000000,
        confirmations: 79,
        locked: false,
        path: 'm/0/0',
        publicKeys: ['03e00bb0cb0fdf50489df10dbeb0004c5262f44d1cfafaf340772edf9aa54c522f']
      }, {
        txid: '073ada18d2fe78d924ab807d6f308df997e64a617b23d5fd297fa9b5204f783b',
        vout: 4,
        address: '1L3z9LPd861FWQhf3vDn89Fnc9dkdBo2CG',
        scriptPubKey: '76a914d0faec47bebd22b7168a6298c3b4d3d7dc84fe2088ac',
        satoshis: 100000000,
        confirmations: 92,
        locked: false,
        path: 'm/0/0',
        publicKeys: ['03e00bb0cb0fdf50489df10dbeb0004c5262f44d1cfafaf340772edf9aa54c522f']
      }],
      walletM: 1,
      walletN: 1,
      requiredSignatures: 1,
      requiredRejections: 1,
      status: 'pending',
      txid: undefined,
      broadcastedOn: undefined,
      inputPaths: ['m/0/0', 'm/0/0'],
      actions: [],
      outputOrder: [0, 1],
      fee: 3900,
      feeLevel: undefined,
      feePerKb: 10000,
      excludeUnconfirmedUtxos: false,
      addressType: 'P2PKH',
      customData: undefined,
      proposalSignature: '3045022100fd0b595a4db353a1d90fafa3356d93fbdd1aae680ffc463d3b33e3b473f66aa6022077271084b09f8e7bcc92aceb2ae01cdc1bb1d071ada79a70e160ee761bf0cb8d',
      proposalSignaturePubKey: undefined,
      proposalSignaturePubKeySig: undefined,
      derivationStrategy: 'BIP44',
      creatorName: 'copayer 1',
      deleteLockTime: 0
    },
  },
  '2-of-2': {
    xpriv: 'xprv9s21ZrQH143K2rMHbXTJmWTuFx6ssqn1vyRoZqPkCXYchBSkp5ey8kMJe84sxfXq5uChWH4gk94rWbXZt2opN9kg4ufKGvUM7HQSLjnoh7e',
    xpub: 'xpub661MyMwAqRbcFLRkhYzK8eQdoywNHJVsJCMQNDoMks5bZymuMcyDgYfnVQYq2Q9npnVmdTAthYGc3N3uxm5sEdnTpSqBc4YYTAhNnoSxCm9',
    signatures: ['304402201d210f731fa8cb8473ce49554382ad5d950c963d48b173a0591f13ed8cee10ce022027b30dc3a55c46b1f977a72491d338fc14b6d13a7b1a7c5a35950d8543c1ced6'],
    rawTx: '0100000001ab069f7073be9b491bb1ad4233a45d2e383082ccc7206df905662d6d8499e66e08000000910047304402201d210f731fa8cb8473ce49554382ad5d950c963d48b173a0591f13ed8cee10ce022027b30dc3a55c46b1f977a72491d338fc14b6d13a7b1a7c5a35950d8543c1ced6014752210319008ffe1b3e208f5ebed8f46495c056763f87b07930a7027a92ee477fb0cb0f2103b5f035af8be40d0db5abb306b7754949ab39032cf99ad177691753b37d10130152aeffffffff0380969800000000001976a91451224bca38efcaa31d5340917c3f3f713b8b20e488ac002d3101000000001976a91451224bca38efcaa31d5340917c3f3f713b8b20e488ac70f62b040000000017a914778192003f0e9e1d865c082179cc3dae5464b03d8700000000',
    creationArgs: {
      message: 'some message',
      outputs: [{
        toAddress: "18PzpUFkFZE8zKWUPvfykkTxmB9oMR8qP7",
        amount: 10000000,
        message: "first message"
      }, {
        toAddress: "18PzpUFkFZE8zKWUPvfykkTxmB9oMR8qP7",
        amount: 20000000,
        message: "second message"
      }]
    },
    txProposal: {
      "version": 3,
      "createdOn": 1423146231,
      "id": "75c34f49-1ed6-255f-e9fd-0c71ae75ed1e",
      "walletId": "1",
      "creatorId": "1",
      "network": "livenet",
      "amount": 30000000,
      "message": 'some message',
      "proposalSignature": '7035022100896aeb8db75fec22fddb5facf791927a996eb3aee23ee6deaa15471ea46047de02204c0c33f42a9d3ff93d62738712a8c8a5ecd21b45393fdd144e7b01b5a186f1f9',
      "changeAddress": {
        "version": '1.0.0',
        "createdOn": 1424372337,
        "address": '3CauZ5JUFfmSAx2yANvCRoNXccZ3YSUjXH',
        "path": 'm/2147483647/1/0',
        "publicKeys": ['030562cb099e6043dc499eb359dd97c9d500a3586498e4bcf0228a178cc20e6f16',
          '0367027d17dbdfc27b5e31f8ed70e14d47949f0fa392261e977db0851c8b0d6fac',
          '0315ae1e8aa866794ae603389fb2b8549153ebf04e7cdf74501dadde5c75ddad11'
        ]
      },
      "inputs": [{
        "txid": "6ee699846d2d6605f96d20c7cc8230382e5da43342adb11b499bbe73709f06ab",
        "vout": 8,
        "satoshis": 100000000,
        "scriptPubKey": "a914a8a9648754fbda1b6c208ac9d4e252075447f36887",
        "address": "3H4pNP6J4PW4NnvdrTg37VvZ7h2QWuAwtA",
        "path": "m/2147483647/0/1",
        "publicKeys": ["0319008ffe1b3e208f5ebed8f46495c056763f87b07930a7027a92ee477fb0cb0f", "03b5f035af8be40d0db5abb306b7754949ab39032cf99ad177691753b37d101301"]
      }],
      "inputPaths": ["m/2147483647/0/1"],
      "requiredSignatures": 2,
      "requiredRejections": 1,
      "walletN": 2,
      "addressType": "P2SH",
      "status": "pending",
      "actions": [],
      "fee": 10000,
      "outputs": [{
        "toAddress": "18PzpUFkFZE8zKWUPvfykkTxmB9oMR8qP7",
        "amount": 10000000,
        "message": "first message"
      }, {
        "toAddress": "18PzpUFkFZE8zKWUPvfykkTxmB9oMR8qP7",
        "amount": 20000000,
        "message": "second message"
      }, ],
      "outputOrder": [0, 1, 2]
    }
  },
};
