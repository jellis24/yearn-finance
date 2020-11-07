import React, { useEffect } from 'react';
import { Switch, Route } from 'react-router-dom';
import Splash from 'containers/Splash/Loadable';
import { useSelector, useDispatch } from 'react-redux';
import Dashboard from 'containers/Dashboard/Loadable';
import Main from 'containers/Main/Loadable';
import NotFoundPage from 'containers/NotFoundPage/Loadable';
import { useInjectSaga } from 'utils/injectSaga';
import { useInjectReducer } from 'utils/injectReducer';
import { useWeb3 } from 'containers/ConnectionProvider/hooks';
import { useDrizzle } from 'containers/DrizzleProvider/hooks';
import vaultsSaga from 'containers/Vaults/saga';
import GlobalStyle from '../../global-styles';

import saga from './saga';
import reducer from './reducer';
import { selectReady } from './selectors';
import { appReady } from './actions';

export default function App() {
  useInjectSaga({ key: 'vaults', saga: vaultsSaga });
  useInjectSaga({ key: 'app', saga });
  useInjectReducer({ key: 'app', reducer });
  const web3 = useWeb3();
  const drizzle = useDrizzle();
  const dispatch = useDispatch();
  const ready = useSelector(selectReady());
  const appReadyChanged = () => {
    if (ready) {
      dispatch(appReady(web3, drizzle));
    }
  };
  useEffect(appReadyChanged, [ready]);
  return (
    <div>
      <Switch>
        <Route exact path="/" component={Splash} />
        <Route exact path="/dashboard" component={Dashboard} />
        <Route path="/vaults" component={Main} />
        <Route path="/yusd" component={Main} />
        <Route path="/stats" component={Main} />
        <Route path="/gov" component={Main} />
        <Route component={NotFoundPage} />
      </Switch>
      <GlobalStyle />
    </div>
  );
}
