let Web3 = require('web3')
let yahooStockPrices = require('yahoo-stock-prices')
let nearAPI = require('near-api-js')
let { KeyPair } = nearAPI
let fetch = require('node-fetch')
let getConfig = require('./config')
const { pool, sql } = require('./db')

async function lastPrices() {
  let p = await pool.query(sql.listLastPrices())
  p = p.rows
  let result = {}
  for (let r of p) {
    result[r.name] = r.price
  }
  return result
}

let last_prices

async function main() {
  let { contract, nearConfig } = await initContract()

  let prices
  while (true) {
    let oldPrices
    try {
      if (prices) {
        oldPrices = prices
      } else {
        oldPrices = await lastPrices()
      }
      last_prices = oldPrices
      prices = await getPrices(oldPrices)
      break
    } catch (e) {
      console.error('error to get price: ')
      console.error(e)
      console.error('retrying in 1 min')
      await sleep(60000)
      continue
    }
  }

  // current oracle is very centralize, however, none of existing oracle has all variety of price data that aUSD needed,
  // so, we would have to build our own decentralized oracle.
  // In short, oracle is a piece of nodejs app, that take an ART staker's function call key, and continuously trying to submit data
  // All submitted prices are queued, when the last submitter (pass threshold), and verify all prices are within 0.5%, then price
  // submit is valid, all stakers get reward. Otherwise, the very off staker won't get reward. And price is now submitted.
  // By then, artcoin.network, will not run oracle in future to be fully decentralized. We'll still keep a indexing database which would
  // keep the history of price, and maintain the frontend UI
  await insertPricesToDB(prices)

  while (true) {
    try {
      await submitPrices(prices, contract)
      break
    } catch (e) {
      console.error('error to submit price: ')
      console.error(e)
      console.error('sleeping for 1 min')
      await sleep(60000)
      continue
    }
  }

  console.log('submit price done')
}

async function insertPricesToDB(prices) {
  for (let name in prices) {
    let price = prices[name]
    let time = new Date()
    await pool.query(
      sql.insertPrice({
        name,
        time: time.toISOString(),
        price: price,
      })
    )
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function priceToContract(price) {
  return Math.floor(Number(price) * Math.pow(10, 8)).toString()
}

async function getLastArtPrice(_) {
  last_art_price = last_prices['art'] || Math.random() * 5 + 5
  // art is not on market, just grab a mocked price for now
  new_art_price = last_art_price * (1.101 - Math.random() / 5)
  if (new_art_price < 1) {
    new_art_price *= 1.5
  }
  last_prices['art'] = new_art_price
  return new_art_price
}

async function getPriceFromChainLink(handle) {
  let url = 'https://mainnet.infura.io/v3/28c4cd108b704522b53bf9760086e8dd'
  const web3 = new Web3(url)
  const aggregatorV3InterfaceABI = [
    {
      inputs: [],
      name: 'decimals',
      outputs: [{ internalType: 'uint8', name: '', type: 'uint8' }],
      stateMutability: 'view',
      type: 'function',
    },
    {
      inputs: [],
      name: 'description',
      outputs: [{ internalType: 'string', name: '', type: 'string' }],
      stateMutability: 'view',
      type: 'function',
    },
    {
      inputs: [{ internalType: 'uint80', name: '_roundId', type: 'uint80' }],
      name: 'getRoundData',
      outputs: [
        { internalType: 'uint80', name: 'roundId', type: 'uint80' },
        { internalType: 'int256', name: 'answer', type: 'int256' },
        { internalType: 'uint256', name: 'startedAt', type: 'uint256' },
        { internalType: 'uint256', name: 'updatedAt', type: 'uint256' },
        { internalType: 'uint80', name: 'answeredInRound', type: 'uint80' },
      ],
      stateMutability: 'view',
      type: 'function',
    },
    {
      inputs: [],
      name: 'latestRoundData',
      outputs: [
        { internalType: 'uint80', name: 'roundId', type: 'uint80' },
        { internalType: 'int256', name: 'answer', type: 'int256' },
        { internalType: 'uint256', name: 'startedAt', type: 'uint256' },
        { internalType: 'uint256', name: 'updatedAt', type: 'uint256' },
        { internalType: 'uint80', name: 'answeredInRound', type: 'uint80' },
      ],
      stateMutability: 'view',
      type: 'function',
    },
    {
      inputs: [],
      name: 'version',
      outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
      stateMutability: 'view',
      type: 'function',
    },
  ]
  const addr = CHAINLINK_FEEDS[handle].addr
  const priceFeed = new web3.eth.Contract(aggregatorV3InterfaceABI, addr)
  let data = await priceFeed.methods.latestRoundData().call()
  return Number(data.answer) / Math.pow(10, CHAINLINK_FEEDS[handle].multi)
}

async function getPriceFromYahooFinance(handle) {
  console.log('get price from yahoo for ' + handle)
  // bug, stuck forever
  // const data = await yahooStockPrices.getCurrentData(handle)
  const baseUrl = 'https://finance.yahoo.com/quote/'
  req = await fetch(`${baseUrl}${handle}/`)
  console.log('fetch done')
  let body = await req.text()
  console.log('text done')
  let price = body
    .split(`"${handle}":{"sourceInterval"`)[1]
    .split('regularMarketPrice')[1]
    .split('fmt":"')[1]
    .split('"')[0]
  console.log('scratch done')

  price = parseFloat(price.replace(',', ''))

  console.log('get price from yahoo for ' + handle + ' done')
  return price
}

async function getCoinPriceFromCoingecko(handle) {
  let req = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${handle}&vs_currencies=usd`
  )
  let resp = await req.json()
  return resp[handle].usd
}

const CHAINLINK_FEEDS = {
  BTC: {
    addr: '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c',
    multi: 8,
  },
  EUR: {
    addr: '0xb49f677943BC038e9857d61E7d053CaA2C1734C1',
    multi: 8,
  },
  GOLD: {
    addr: '0x214eD9Da11D2fbe465a6fc601a91E62EbEc1a0D6',
    multi: 8,
  },
}

const ASSETS = [
  {
    name: 'art',
    handle: 'art',
    fun: getLastArtPrice,
  },
  {
    name: 'aBTC',
    handle: 'BTC',
    fun: getPriceFromChainLink,
  },
  {
    name: 'aEUR',
    handle: 'EUR',
    fun: getPriceFromChainLink,
  },
  {
    name: 'aGOLD',
    handle: 'GOLD',
    fun: getPriceFromChainLink,
  },
  {
    name: 'aSPY',
    handle: 'SPY',
    fun: getPriceFromYahooFinance,
  },
  {
    name: 'aNEAR',
    handle: 'near',
    fun: getCoinPriceFromCoingecko,
  },
  {
    name: 'aGOOG',
    handle: 'GOOG',
    fun: getPriceFromYahooFinance,
  },
  {
    name: 'aAAPL',
    handle: 'AAPL',
    fun: getPriceFromYahooFinance,
  },
  {
    name: 'aTSLA',
    handle: 'TSLA',
    fun: getPriceFromYahooFinance,
  },
  {
    name: 'aNFLX',
    handle: 'NFLX',
    fun: getPriceFromYahooFinance,
  },
  {
    name: 'aFB',
    handle: 'FB',
    fun: getPriceFromYahooFinance,
  },
]

function NX(n) {
  return ({ prices, oldPrices, baseName, name, initial }) => {
    let baseOldPrice = oldPrices[baseName]
    let basePrice = prices[baseName]
    let oldPrice = oldPrices[name] || initial
    let baseIncrease = (basePrice - baseOldPrice) / baseOldPrice
    let increase = baseIncrease * n
    let price = oldPrice * (1 + increase)
    return price
  }
}

const DERIVED_ASSETS = [
  {
    name: 'a3xBTC',
    baseName: 'aBTC',
    derive: NX(3),
    initial: 10000,
  },
  {
    name: 'a2xBTC',
    baseName: 'aBTC',
    derive: NX(2),
    initial: 10000,
  },
  {
    name: 'a5xBTC',
    baseName: 'aBTC',
    derive: NX(5),
    initial: 10000,
  },
  {
    name: 'a10xBTC',
    baseName: 'aBTC',
    derive: NX(10),
    initial: 10000,
  },
  {
    name: 'a-xBTC',
    baseName: 'aBTC',
    derive: NX(-1),
    initial: 10000,
  },
  {
    name: 'a-2xBTC',
    baseName: 'aBTC',
    derive: NX(-2),
    initial: 10000,
  },
  {
    name: 'a-3xBTC',
    baseName: 'aBTC',
    derive: NX(-3),
    initial: 10000,
  },
  {
    name: 'a-5xBTC',
    baseName: 'aBTC',
    derive: NX(-5),
    initial: 10000,
  },
  {
    name: 'a-10xBTC',
    baseName: 'aBTC',
    derive: NX(-10),
    initial: 10000,
  },
]

async function getPrices(oldPrices) {
  console.log('get prices')
  let prices = {}

  for (let a of ASSETS) {
    let p = await a['fun'](a['handle'])
    prices[a['name']] = p
    console.log(`current ${a['name']} price: $ ${p}`)
  }

  for (let d of DERIVED_ASSETS) {
    let p = d['derive']({
      oldPrices,
      prices,
      name: d['name'],
      baseName: d['baseName'],
      initial: d['initial'],
    })
    prices[d['name']] = p
    console.log(`current ${d['name']} price: $ ${p}`)
  }

  return prices
}

async function initContract() {
  let networkId = 'testnet'
  console.log(networkId)
  const nearConfig = getConfig(networkId)

  // Initializing connection to the NEAR TestNet
  let keyStore = new nearAPI.keyStores.InMemoryKeyStore()
  let fs = require('fs')
  let kf = fs.readFileSync(nearConfig.contractName + '.json')
  let k = JSON.parse(kf)
  keyStore.setKey(
    networkId,
    nearConfig.contractName,
    KeyPair.fromString(k.private_key)
  )
  if (networkId == 'testnet')
    keyStore.setKey(
      'default',
      nearConfig.contractName,
      KeyPair.fromString(k.private_key)
    )
  const near = await nearAPI.connect({
    deps: {
      keyStore,
    },
    ...nearConfig,
  })

  let account = await near.account(nearConfig.contractName)

  // Initializing our contract APIs by contract name and configuration
  const contract = await new nearAPI.Contract(
    account,
    nearConfig.contractName,
    {
      // View methods are read-only – they don't modify the state, but usually return some value
      viewMethods: [],
      // Change methods can modify the state, but you don't receive the returned value when called
      changeMethods: ['submit_price', 'submit_asset_price'],
      // Sender is the account ID to initialize transactions.
      // getAccountId() will return empty string if user is still unauthorized
      sender: nearConfig.contractName,
    }
  )

  return { contract, nearConfig }
}

async function submitPrices(prices, contract) {
  console.log('submit price')
  console.log(prices)
  console.log('submitting art')
  try {
    await contract.submit_price({ price: priceToContract(prices['art']) })
  } catch (e) {
    console.log('=== submit art price error, ignore')
    console.log(e)
  }
  for (let k in prices) {
    if (k != 'art') {
      let name = k
      console.log('submitting ' + name)
      try {
        await contract.submit_asset_price({
          asset: name,
          price: priceToContract(prices[k]),
        })
      } catch (e) {
        console.log('=== submit price of' + name + 'failed, ignore')
        console.log(e)
      }
    }
  }
}

main()
